import type {
  DownloadedOpenPdf,
  OpenPaperCandidate,
  OpenPaperMetadata,
  OpenPaperSearchResult,
} from "./europe-pmc.js";
import { RateLimitError } from "./rate-limiter.js";

const DOI_PATTERN = /^10\.\d{4,9}\/[\x21-\x7e]+$/i;
const PMID_PATTERN = /^\d{5,10}$/;
const PMCID_PATTERN = /^PMC\d+$/i;
const ARXIV_PATTERN = /^(?:arxiv:)?(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

export function normalizePaperQuery(query: string): string {
  const value = query.trim();
  const prefixed = value.replace(/^doi:\s*/i, "");
  if (DOI_PATTERN.test(prefixed)) return prefixed;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && ["doi.org", "dx.doi.org"].includes(url.hostname) && !url.username && !url.password) {
      const doi = decodeURIComponent(url.pathname.slice(1));
      if (DOI_PATTERN.test(doi)) return doi;
    }
  } catch {
    // Plain titles and identifiers are not URLs.
  }
  return value;
}

export interface OpenPaperSource {
  readonly sourceName: string;
  accepts(versionId: string): boolean;
  search(query: string): Promise<OpenPaperSearchResult>;
  download(versionId: string): Promise<DownloadedOpenPdf>;
}

export type OpenPaperDownload = (
  source: OpenPaperSource,
  versionId: string,
) => Promise<DownloadedOpenPdf>;

export type OpenPaperSearch = (
  source: OpenPaperSource,
  query: string,
) => Promise<OpenPaperSearchResult>;

export interface SourceAttempt {
  source: string;
  stage: "search" | "download";
  status: "found" | "empty" | "failed" | "downloaded";
  message?: string;
}

export interface ResolvedOpenPaperSearch extends OpenPaperSearchResult {
  attempts: SourceAttempt[];
}

export type BestOpenPaperResult =
  | {
      status: "downloaded";
      query: string;
      candidate: OpenPaperCandidate;
      paper: DownloadedOpenPdf;
      attempts: SourceAttempt[];
    }
  | {
      status: "selection_required" | "not_found";
      query: string;
      candidates: OpenPaperCandidate[];
      attempts: SourceAttempt[];
    }
  | {
      status: "exhausted";
      query: string;
      candidate: OpenPaperCandidate;
      attempts: SourceAttempt[];
    };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function candidateKey(candidate: OpenPaperCandidate): string {
  if (candidate.metadata.doi) return `doi:${candidate.metadata.doi.toLowerCase()}`;
  if (candidate.metadata.pmcid) return `pmcid:${candidate.metadata.pmcid.toUpperCase()}`;
  if (candidate.metadata.pmid) return `pmid:${candidate.metadata.pmid}`;
  return `title:${normalizedTitle(candidate.metadata.title)}:${candidate.metadata.year ?? ""}`;
}

function mergeMetadata(first: OpenPaperMetadata, next: OpenPaperMetadata): OpenPaperMetadata {
  return {
    title: first.title || next.title,
    authors: first.authors || next.authors,
    year: first.year ?? next.year,
    journal: first.journal ?? next.journal,
    doi: first.doi ?? next.doi,
    pmid: first.pmid ?? next.pmid,
    pmcid: first.pmcid ?? next.pmcid,
  };
}

function mergeCandidates(candidateLists: OpenPaperCandidate[][]): OpenPaperCandidate[] {
  const merged = new Map<string, OpenPaperCandidate>();
  for (const candidate of candidateLists.flat()) {
    const key = candidateKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, structuredClone(candidate));
      continue;
    }
    existing.metadata = mergeMetadata(existing.metadata, candidate.metadata);
    const known = new Set(existing.versions.map((version) => version.versionId));
    existing.versions.push(...candidate.versions.filter((version) => !known.has(version.versionId)));
  }
  return [...merged.values()];
}

function selectedCandidate(query: string, candidates: OpenPaperCandidate[]): OpenPaperCandidate | undefined {
  const normalized = query.trim();
  const lower = normalized.toLowerCase();
  const requestedArxiv = ARXIV_PATTERN.test(normalized) ? lower.replace(/^arxiv:/, "") : null;
  const exactIdentifiers = candidates.filter((candidate) =>
    candidate.metadata.doi?.toLowerCase() === lower ||
    candidate.metadata.pmcid?.toLowerCase() === lower ||
    candidate.metadata.pmid === normalized ||
    candidate.candidateId.toLowerCase().endsWith(`:${lower}`) ||
    (requestedArxiv !== null && (() => {
      const candidateArxiv = candidate.candidateId.toLowerCase().match(/^arxiv:(.+)$/)?.[1];
      if (!candidateArxiv) return false;
      return /v\d+$/.test(requestedArxiv)
        ? candidateArxiv === requestedArxiv
        : candidateArxiv.replace(/v\d+$/, "") === requestedArxiv;
    })())
  );
  if (exactIdentifiers.length === 1) return exactIdentifiers[0];
  if (DOI_PATTERN.test(normalized)) return undefined;
  const title = normalizedTitle(normalized);
  const exactTitles = candidates.filter((candidate) => normalizedTitle(candidate.metadata.title) === title);
  return exactTitles.length === 1 ? exactTitles[0] : undefined;
}

function isExactIdentifier(query: string): boolean {
  const normalized = query.trim();
  return DOI_PATTERN.test(normalized) || PMID_PATTERN.test(normalized) ||
    PMCID_PATTERN.test(normalized) || ARXIV_PATTERN.test(normalized);
}

export class OpenPaperResolver {
  constructor(private readonly sources: readonly OpenPaperSource[]) {}

  async search(
    query: string,
    searchSource: OpenPaperSearch = (source, sourceQuery) => source.search(sourceQuery),
  ): Promise<ResolvedOpenPaperSearch> {
    query = normalizePaperQuery(query);
    const candidateLists: OpenPaperCandidate[][] = [];
    const attempts: SourceAttempt[] = [];
    for (const source of this.sources) {
      try {
        const result = await searchSource(source, query);
        candidateLists.push(result.candidates);
        attempts.push({
          source: source.sourceName,
          stage: "search",
          status: result.candidates.length > 0 ? "found" : "empty",
        });
      } catch (error) {
        attempts.push({ source: source.sourceName, stage: "search", status: "failed", message: message(error) });
      }
    }
    return { query: query.trim(), candidates: mergeCandidates(candidateLists), attempts };
  }

  async fetchBest(
    query: string,
    download: OpenPaperDownload = (source, versionId) => source.download(versionId),
    searchSource: OpenPaperSearch = (source, sourceQuery) => source.search(sourceQuery),
  ): Promise<BestOpenPaperResult> {
    query = normalizePaperQuery(query);
    if (isExactIdentifier(query)) return this.fetchExactIdentifier(query.trim(), download, searchSource);
    const search = await this.search(query, searchSource);
    if (search.candidates.length === 0) {
      return { status: "not_found", query: search.query, candidates: [], attempts: search.attempts };
    }
    const candidate = selectedCandidate(search.query, search.candidates);
    if (!candidate) {
      return {
        status: "selection_required",
        query: search.query,
        candidates: search.candidates,
        attempts: search.attempts,
      };
    }
    const attempts = [...search.attempts];
    for (const version of candidate.versions) {
      const source = this.sources.find((item) => item.accepts(version.versionId));
      if (!source) continue;
      try {
        const paper = await download(source, version.versionId);
        attempts.push({ source: source.sourceName, stage: "download", status: "downloaded" });
        return { status: "downloaded", query: search.query, candidate, paper, attempts };
      } catch (error) {
        attempts.push({ source: source.sourceName, stage: "download", status: "failed", message: message(error) });
        if (error instanceof RateLimitError) break;
      }
    }
    return { status: "exhausted", query: search.query, candidate, attempts };
  }

  private async fetchExactIdentifier(
    query: string,
    download: OpenPaperDownload,
    searchSource: OpenPaperSearch,
  ): Promise<BestOpenPaperResult> {
    const attempts: SourceAttempt[] = [];
    const matched: OpenPaperCandidate[] = [];
    for (const source of this.sources) {
      let result: OpenPaperSearchResult;
      try {
        result = await searchSource(source, query);
        const candidate = selectedCandidate(query, result.candidates);
        attempts.push({
          source: source.sourceName,
          stage: "search",
          status: candidate ? "found" : "empty",
        });
        if (!candidate) continue;
        matched.push(candidate);
        for (const version of candidate.versions) {
          if (!source.accepts(version.versionId)) continue;
          try {
            const paper = await download(source, version.versionId);
            attempts.push({ source: source.sourceName, stage: "download", status: "downloaded" });
            return { status: "downloaded", query, candidate, paper, attempts };
          } catch (error) {
            attempts.push({ source: source.sourceName, stage: "download", status: "failed", message: message(error) });
            if (error instanceof RateLimitError) break;
          }
        }
      } catch (error) {
        attempts.push({ source: source.sourceName, stage: "search", status: "failed", message: message(error) });
      }
    }
    const candidates = mergeCandidates([matched]);
    if (candidates.length === 0) return { status: "not_found", query, candidates: [], attempts };
    return { status: "exhausted", query, candidate: candidates[0]!, attempts };
  }

  sourceForVersion(versionId: string): OpenPaperSource | undefined {
    return this.sources.find((source) => source.accepts(versionId));
  }

  async download(versionId: string): Promise<DownloadedOpenPdf> {
    const source = this.sourceForVersion(versionId);
    if (!source) throw new Error("version_id does not belong to a configured open-paper source");
    return source.download(versionId);
  }
}
