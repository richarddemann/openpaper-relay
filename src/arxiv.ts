import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { XMLParser } from "fast-xml-parser";
import type {
  DownloadedOpenPdf,
  OpenPaperCandidate,
  OpenPaperMetadata,
  OpenPaperSearchResult,
  OpenPaperVersion,
} from "./europe-pmc.js";
import { boundedResponseBody } from "./http.js";
import { SecurePdfDownloader, type DownloadedPdfBytes } from "./secure-download.js";

const API_ORIGIN = "https://export.arxiv.org";
const PDF_ORIGIN = "https://arxiv.org";
const DOI_PATTERN = /^10\.\d{4,9}\/[\x21-\x7e]+$/i;
const ARXIV_ID = /^(?:arxiv:)?((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)$/i;
const VERSION_ID = /^arxiv:([A-Za-z0-9_-]+):pdf:([a-f0-9]{64})$/;
const MAX_METADATA_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RECENT_RECORD_TTL_MS = 60_000;
const MAX_RECENT_RECORDS = 100;

type Fetcher = typeof fetch;
type PdfDownloader = (url: string) => Promise<DownloadedPdfBytes>;

interface AtomAuthor {
  name?: string;
}

interface AtomLink {
  "@_href"?: string;
  "@_type"?: string;
  "@_title"?: string;
}

interface AtomEntry {
  id?: string;
  title?: string;
  published?: string;
  updated?: string;
  author?: AtomAuthor[];
  link?: AtomLink[];
  "arxiv:doi"?: string;
  "arxiv:license"?: { "@_href"?: string };
}

interface AtomFeed {
  feed?: { entry?: AtomEntry[] };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (_name, path) => ["feed.entry", "feed.entry.author", "feed.entry.link"].includes(String(path)),
});

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeId(id: string): string {
  return Buffer.from(id).toString("base64url");
}

function decodeId(encoded: string): string {
  const id = Buffer.from(encoded, "base64url").toString("utf8");
  if (!ARXIV_ID.test(id) || encodeId(id) !== encoded) throw new Error("invalid arXiv version_id");
  return id;
}

function arxivId(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!(["arxiv.org", "export.arxiv.org"].includes(url.hostname))) return null;
    const match = /^\/abs\/(.+)$/.exec(url.pathname);
    const id = match?.[1];
    return id && ARXIV_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function pdfUrl(id: string): string {
  return `${PDF_ORIGIN}/pdf/${id}`;
}

function hasMatchingPdfLink(entry: AtomEntry, id: string): boolean {
  return (Array.isArray(entry.link) ? entry.link : []).some((link) => {
    if (link["@_type"] !== "application/pdf" || !link["@_href"]) return false;
    try {
      const url = new URL(link["@_href"]);
      return url.hostname === "arxiv.org" && url.pathname.replace(/\.pdf$/i, "") === `/pdf/${id}`;
    } catch {
      return false;
    }
  });
}

function safeLicense(entry: AtomEntry): string | null {
  const value = entry["arxiv:license"]?.["@_href"];
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function normalize(entry: AtomEntry): OpenPaperCandidate | null {
  const id = arxivId(entry.id);
  const title = entry.title?.replace(/\s+/g, " ").trim();
  if (!id || !title || !hasMatchingPdfLink(entry, id)) return null;
  const url = pdfUrl(id);
  const year = /^\d{4}/.exec(entry.published ?? "")?.[0] ?? null;
  const metadata: OpenPaperMetadata = {
    title,
    authors: (Array.isArray(entry.author) ? entry.author : [])
      .map((author) => author.name?.replace(/\s+/g, " ").trim())
      .filter((name): name is string => Boolean(name))
      .join(", "),
    year,
    journal: null,
    doi: entry["arxiv:doi"]?.trim().toLowerCase() || null,
    pmid: null,
    pmcid: null,
  };
  const suffix = /v(\d+)$/i.exec(id)?.[1];
  const version: OpenPaperVersion = {
    versionId: `arxiv:${encodeId(id)}:pdf:${fingerprint(url)}`,
    label: suffix ? `arXiv v${suffix} preprint` : "arXiv preprint",
    license: safeLicense(entry),
    source: "arXiv",
    landingPage: `${PDF_ORIGIN}/abs/${id}`,
  };
  return { candidateId: `arxiv:${id}`, metadata, versions: [version] };
}

export class ArxivClient {
  readonly sourceName = "arXiv";
  private readonly downloadPdf: PdfDownloader;
  private lastRequestAt = 0;
  private readonly recentRecords = new Map<string, { candidate: OpenPaperCandidate; expiresAt: number }>();

  constructor(
    maxPdfBytes: number,
    private readonly fetcher: Fetcher = fetch,
    downloader?: PdfDownloader,
    private readonly minimumIntervalMs = fetcher === fetch ? 3_000 : 0,
  ) {
    this.downloadPdf = downloader ?? ((url) => new SecurePdfDownloader(maxPdfBytes).download(url));
  }

  accepts(versionId: string): boolean {
    return VERSION_ID.test(versionId);
  }

  async search(query: string): Promise<OpenPaperSearchResult> {
    const normalized = query.trim();
    if (normalized.length < 3 || normalized.length > 500) {
      throw new Error("paper query must contain between 3 and 500 characters");
    }
    const match = ARXIV_ID.exec(normalized);
    const entries = match?.[1]
      ? await this.entries({ idList: match[1] })
      : await this.entries({ searchQuery: DOI_PATTERN.test(normalized)
          ? `doi:\"${normalized}\"`
          : `ti:\"${normalized.replace(/[\\"]/g, "\\$&")}\"` });
    const candidates = entries.map(normalize).filter((candidate): candidate is OpenPaperCandidate => candidate !== null);
    this.remember(candidates);
    return {
      query: normalized,
      candidates,
    };
  }

  async download(versionId: string): Promise<DownloadedOpenPdf> {
    const match = VERSION_ID.exec(versionId);
    if (!match?.[1] || !match[2]) throw new Error("invalid arXiv version_id");
    const id = decodeId(match[1]);
    const expectedFingerprint = match[2];
    const recent = this.recentRecords.get(versionId);
    if (recent && recent.expiresAt < Date.now()) this.recentRecords.delete(versionId);
    const candidate = recent && recent.expiresAt >= Date.now() && recent.candidate.candidateId === `arxiv:${id}`
      ? recent.candidate
      : (await this.entries({ idList: id }))
        .map(normalize)
        .find((item): item is OpenPaperCandidate => item?.candidateId === `arxiv:${id}`);
    const version = candidate?.versions.find((item) => item.versionId === versionId);
    const url = pdfUrl(id);
    if (!candidate || !version || fingerprint(url) !== expectedFingerprint) {
      throw new Error("the selected arXiv PDF version is no longer available");
    }
    const pdf = await this.downloadPdf(url);
    return { ...pdf, metadata: candidate.metadata, version };
  }

  private async entries(input: { idList?: string; searchQuery?: string }): Promise<AtomEntry[]> {
    const url = new URL("/api/query", API_ORIGIN);
    if (input.idList) url.searchParams.set("id_list", input.idList);
    if (input.searchQuery) url.searchParams.set("search_query", input.searchQuery);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", "5");
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingDelay = this.minimumIntervalMs - (Date.now() - this.lastRequestAt);
      if (remainingDelay > 0) await delay(remainingDelay);
      response = await this.fetcher(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/atom+xml" },
      })
      .finally(() => { this.lastRequestAt = Date.now(); });
      if (response.status !== 429 || attempt === 1) break;
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      const retryDelay = Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1_000) : 0;
      await delay(Math.min(30_000, Math.max(this.minimumIntervalMs, retryDelay)));
    }
    if (!response) throw new Error("arXiv metadata request did not return a response");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error("arXiv metadata request returned an unexpected redirect");
    }
    if (!response.ok) throw new Error(`arXiv metadata request failed with HTTP ${response.status}`);
    const bytes = await boundedResponseBody(response, MAX_METADATA_BYTES);
    const parsed = parser.parse(bytes.toString("utf8")) as AtomFeed;
    return Array.isArray(parsed.feed?.entry) ? parsed.feed.entry : [];
  }

  private remember(candidates: OpenPaperCandidate[]): void {
    const now = Date.now();
    for (const [versionId, record] of this.recentRecords) {
      if (record.expiresAt < now) this.recentRecords.delete(versionId);
    }
    for (const candidate of candidates) {
      for (const version of candidate.versions) {
        this.recentRecords.delete(version.versionId);
        this.recentRecords.set(version.versionId, { candidate, expiresAt: now + RECENT_RECORD_TTL_MS });
        while (this.recentRecords.size > MAX_RECENT_RECORDS) {
          const oldest = this.recentRecords.keys().next().value as string | undefined;
          if (!oldest) break;
          this.recentRecords.delete(oldest);
        }
      }
    }
  }
}
