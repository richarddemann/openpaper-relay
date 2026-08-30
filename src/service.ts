import { resolve } from "node:path";
import { ArxivClient } from "./arxiv.js";
import { AuthorizedBrowser } from "./browser.js";
import { findSite, loadConfig } from "./config.js";
import { EuropePmcClient, type DownloadedOpenPdf } from "./europe-pmc.js";
import { PdfTextExtractor, type ExtractedText } from "./extractor.js";
import { CrossProcessLock } from "./lock.js";
import { OpenPaperResolver, type OpenPaperSource } from "./open-paper-resolver.js";
import { PersistentSlidingWindowRateLimiter } from "./rate-limiter.js";
import { PaperStore } from "./store.js";
import type { AppConfig, FetchResult, SiteConfig } from "./types.js";
import { UnpaywallClient } from "./unpaywall.js";

export class PaperFetcherService {
  readonly store: PaperStore;
  readonly extractor: PdfTextExtractor;
  private readonly browser: AuthorizedBrowser;
  private readonly openPapers: OpenPaperResolver;

  constructor(
    readonly config: AppConfig,
    readonly stateRoot: string,
  ) {
    this.store = new PaperStore(stateRoot, config.maxPdfBytes);
    this.extractor = new PdfTextExtractor(config.extractionTimeoutMs, config.extractionMaxOldSpaceMb);
    this.browser = new AuthorizedBrowser(resolve(stateRoot, "profiles"), config.maxPdfBytes);
    this.openPapers = new OpenPaperResolver([
      new EuropePmcClient(config.maxPdfBytes),
      ...(config.unpaywallEmail ? [new UnpaywallClient(config.unpaywallEmail, config.maxPdfBytes)] : []),
      new ArxivClient(config.maxPdfBytes),
    ]);
  }

  static async create(configPath: string, stateRoot: string): Promise<PaperFetcherService> {
    const service = new PaperFetcherService(await loadConfig(configPath), stateRoot);
    await service.store.initialize();
    return service;
  }

  site(siteId: string): SiteConfig {
    return findSite(this.config, siteId);
  }

  async fetch(identifier: string, siteId: string): Promise<FetchResult> {
    const site = this.site(siteId);
    return this.withSiteLock(siteId, async () => {
      await new PersistentSlidingWindowRateLimiter(
        resolve(this.stateRoot, "rate-limits", `site-${siteId}.json`),
        this.config.maxDownloadsPerHour,
        60 * 60 * 1000,
      ).take();
      const outcome = await this.browser.fetch(site, identifier);
      if (outcome.status === "login_required") {
        return {
          status: "login_required",
          siteId,
          message: `Run npm run login -- ${siteId} locally, complete MFA, then retry this paper.`,
        };
      }
      if (outcome.status === "not_found") {
        return {
          status: "not_found",
          siteId,
          message: "No PDF response or configured PDF control was found. Check the site adapter selectors and allowlist.",
        };
      }
      const paper = await this.store.put(outcome.data, outcome.filename);
      return {
        status: "downloaded",
        paperId: paper.paperId,
        resourceUri: `paper://${paper.paperId}`,
        filename: paper.filename,
        sizeBytes: paper.sizeBytes,
      };
    });
  }

  async searchOpenPapers(query: string) {
    return this.openPapers.search(
      query,
      (source, sourceQuery) => this.withOpenSourceSearch(source, () => source.search(sourceQuery)),
    );
  }

  async downloadOpenPaper(versionId: string) {
    const source = this.openPapers.sourceForVersion(versionId);
    if (!source) throw new Error("version_id does not belong to a configured open-paper source");
    return this.withOpenSourceDownload(source, async () => {
      const downloaded = await this.openPapers.download(versionId);
      return this.storeOpenPaper(downloaded);
    });
  }

  async fetchBestOpenPaper(query: string, siteId?: string) {
    const openResult = await this.openPapers.fetchBest(
      query,
      (source, versionId) => this.withOpenSourceDownload(source, () => source.download(versionId)),
      (source, sourceQuery) => this.withOpenSourceSearch(source, () => source.search(sourceQuery)),
    );
    if (openResult.status === "downloaded") {
      return {
        ...await this.storeOpenPaper(openResult.paper),
        query: openResult.query,
        candidate: openResult.candidate,
        attempts: openResult.attempts,
      };
    }
    const normalized = query.trim();
    const canTryInstitution = siteId && /^10\.\d{4,9}\/[\x21-\x7e]+$/i.test(normalized);
    if (!canTryInstitution || openResult.status === "selection_required") return openResult;
    const authorized = await this.fetch(normalized, siteId);
    return {
      ...authorized,
      query: normalized,
      attempts: [
        ...openResult.attempts,
        {
          source: `Authorized institution (${siteId})`,
          stage: "download" as const,
          status: authorized.status === "downloaded" ? "downloaded" as const : "failed" as const,
          ...(authorized.status === "downloaded" ? {} : { message: authorized.message }),
        },
      ],
    };
  }

  async extractText(paperId: string): Promise<ExtractedText> {
    const paper = await this.store.get(paperId);
    await this.store.read(paperId);
    return this.extractor.extract(paper.path);
  }

  async readPdf(paperId: string): Promise<{ data: Buffer; filename: string }> {
    const paper = await this.store.get(paperId);
    return { data: await this.store.read(paperId), filename: paper.filename };
  }

  async openLogin(siteId: string): Promise<() => Promise<void>> {
    const release = await this.namedLock(`site-${siteId}`).acquire();
    try {
      const context = await this.browser.login(this.site(siteId));
      return async () => {
        try {
          await context.close();
        } finally {
          await release();
        }
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  private async withSiteLock<T>(siteId: string, operation: () => Promise<T>): Promise<T> {
    return this.withNamedLock(`site-${siteId}`, operation);
  }

  private async withNamedLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.namedLock(name).acquire();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private namedLock(name: string): CrossProcessLock {
    return new CrossProcessLock(resolve(this.stateRoot, "locks", `${name}.lock`));
  }

  private async withOpenSourceDownload<T>(source: OpenPaperSource, operation: () => Promise<T>): Promise<T> {
    const sourceKey = source.sourceName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return this.withNamedLock(`source-${sourceKey}`, async () => {
      await new PersistentSlidingWindowRateLimiter(
        resolve(this.stateRoot, "rate-limits", `source-${sourceKey}.json`),
        this.config.maxDownloadsPerHour,
        60 * 60 * 1000,
      ).take();
      return operation();
    });
  }

  private async withOpenSourceSearch<T>(source: OpenPaperSource, operation: () => Promise<T>): Promise<T> {
    const sourceKey = source.sourceName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return this.withNamedLock(`search-${sourceKey}`, async () => {
      await new PersistentSlidingWindowRateLimiter(
        resolve(this.stateRoot, "rate-limits", `search-${sourceKey}.json`),
        this.config.maxSearchesPerHour,
        60 * 60 * 1000,
      ).take();
      return operation();
    });
  }

  private async storeOpenPaper(downloaded: DownloadedOpenPdf) {
    const paper = await this.store.put(downloaded.data, downloaded.filename, {
      provider: downloaded.version.source,
      metadata: downloaded.metadata,
      version: downloaded.version,
    });
    return {
      status: "downloaded" as const,
      paperId: paper.paperId,
      resourceUri: `paper://${paper.paperId}`,
      filename: paper.filename,
      sizeBytes: paper.sizeBytes,
      metadata: downloaded.metadata,
      version: downloaded.version,
    };
  }
}
