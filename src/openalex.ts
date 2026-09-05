import { createHash } from "node:crypto";
import type { DownloadedOpenPdf, OpenPaperCandidate, OpenPaperSearchResult } from "./europe-pmc.js";
import { boundedResponseBody, cancelResponseBody } from "./http.js";
import { SecurePdfDownloader, type DownloadedPdfBytes } from "./secure-download.js";

const API_ORIGIN = "https://api.openalex.org";
const VERSION_ID = /^openalex:(W\d+):pdf:([a-f0-9]{64})$/;
const DOI_PATTERN = /^10\.\d{4,9}\/[\x21-\x7e]+$/i;

interface Location {
  is_oa?: boolean;
  pdf_url?: string | null;
  license?: string | null;
  source?: { display_name?: string } | null;
}
interface Work {
  id?: string;
  doi?: string | null;
  title?: string;
  publication_year?: number | null;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: Location | null;
  locations?: Location[];
}

function fingerprint(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function locations(work: Work): Array<Location & { pdf_url: string }> {
  const seen = new Set<string>();
  return (Array.isArray(work.locations) ? work.locations : []).flatMap((location) => {
    if (!location.is_oa || !location.pdf_url) return [];
    try {
      const url = new URL(location.pdf_url);
      if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ ...location, pdf_url: url.href }];
    } catch {
      return [];
    }
  }).slice(0, 10);
}

function normalize(work: Work): OpenPaperCandidate | null {
  const id = work.id?.match(/^https:\/\/openalex.org\/(W\d+)$/)?.[1];
  const title = work.title?.trim();
  if (!id || !title) return null;
  const doi = work.doi?.replace(/^https?:\/\/(?:dx\.)?doi.org\//i, "").toLowerCase();
  return {
    candidateId: `openalex:${id}`,
    metadata: {
      title,
      doi: doi && DOI_PATTERN.test(doi) ? doi : null,
      authors: (work.authorships ?? []).map((item) => item.author?.display_name).filter(Boolean).join(", "),
      year: work.publication_year == null ? null : String(work.publication_year),
      journal: work.primary_location?.source?.display_name ?? null,
      pmid: null,
      pmcid: null,
    },
    versions: locations(work).map((location) => ({
      versionId: `openalex:${id}:pdf:${fingerprint(location.pdf_url)}`,
      label: location.source?.display_name || "Open-access copy",
      license: location.license ?? null,
      source: "OpenAlex",
      landingPage: `https://openalex.org/${id}`,
    })),
  };
}

export class OpenAlexClient {
  readonly sourceName = "OpenAlex";
  private readonly downloadPdf: (url: string) => Promise<DownloadedPdfBytes>;

  constructor(
    maxPdfBytes: number,
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
    downloader?: (url: string) => Promise<DownloadedPdfBytes>,
  ) {
    this.downloadPdf = downloader ?? ((url) => new SecurePdfDownloader(maxPdfBytes).download(url));
  }

  accepts(versionId: string): boolean {
    return VERSION_ID.test(versionId);
  }

  async search(query: string): Promise<OpenPaperSearchResult> {
    const normalized = query.trim();
    if (normalized.length < 3 || normalized.length > 500) throw new Error("paper query must contain between 3 and 500 characters");
    // Other providers resolve these identifiers. Do not treat them as titles.
    if (/^(?:PMC\d+|\d{5,10}|(?:arxiv:)?\d{4}\.\d{4,5}(?:v\d+)?|(?:arxiv:)?[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i.test(normalized)) {
      return { query: normalized, candidates: [] };
    }
    const url = new URL("/works", API_ORIGIN);
    if (DOI_PATTERN.test(normalized)) url.searchParams.set("filter", `doi:https://doi.org/${normalized}`);
    else url.searchParams.set("search", normalized);
    url.searchParams.set("per_page", "5");
    const data = await this.request(url) as { results?: Work[] } | null;
    return {
      query: normalized,
      candidates: (data?.results ?? []).map(normalize).filter((item): item is OpenPaperCandidate => item !== null),
    };
  }

  async download(versionId: string): Promise<DownloadedOpenPdf> {
    const match = VERSION_ID.exec(versionId);
    if (!match) throw new Error("invalid OpenAlex version_id");
    const work = await this.request(new URL(`/works/${match[1]}`, API_ORIGIN)) as Work | null;
    const candidate = work ? normalize(work) : null;
    const version = candidate?.versions.find((item) => item.versionId === versionId);
    const location = work ? locations(work).find((item) => fingerprint(item.pdf_url) === match[2]) : undefined;
    if (!candidate || !version || !location) throw new Error("the selected OpenAlex PDF version is no longer available");
    const pdf = await this.downloadPdf(location.pdf_url);
    return { ...pdf, metadata: candidate.metadata, version };
  }

  private async request(url: URL): Promise<unknown> {
    const response = await this.fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      if (response.status === 404) return null;
      throw new Error(`OpenAlex request failed with HTTP ${response.status}`);
    }
    return JSON.parse((await boundedResponseBody(response, 2_000_000)).toString("utf8")) as unknown;
  }
}
