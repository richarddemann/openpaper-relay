import { createHash } from "node:crypto";
import type {
  DownloadedOpenPdf,
  OpenPaperCandidate,
  OpenPaperMetadata,
  OpenPaperSearchResult,
  OpenPaperVersion,
} from "./europe-pmc.js";
import { boundedResponseBody, cancelResponseBody } from "./http.js";
import { SecurePdfDownloader, type DownloadedPdfBytes } from "./secure-download.js";

const API_ORIGIN = "https://api.unpaywall.org";
const DOI_PATTERN = /^10\.\d{4,9}\/[\x21-\x7e]+$/i;
const VERSION_ID = /^unpaywall:([A-Za-z0-9_-]+):pdf:([a-f0-9]{64})$/;
const MAX_METADATA_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_VERSIONS_PER_CANDIDATE = 10;

type Fetcher = typeof fetch;
type PdfDownloader = (url: string) => Promise<DownloadedPdfBytes>;

interface UnpaywallAuthor {
  given?: string;
  family?: string;
}

interface UnpaywallLocation {
  host_type?: string;
  version?: string;
  license?: string | null;
  repository_institution?: string | null;
  url_for_landing_page?: string | null;
  url_for_pdf?: string | null;
}

interface UnpaywallRecord {
  doi?: string;
  title?: string;
  year?: number | string | null;
  journal_name?: string | null;
  z_authors?: UnpaywallAuthor[] | null;
  is_oa?: boolean;
  oa_locations?: UnpaywallLocation[];
}

interface UnpaywallSearchResponse {
  results?: Array<{ response?: UnpaywallRecord }>;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeDoi(doi: string): string {
  return Buffer.from(doi.toLowerCase()).toString("base64url");
}

function decodeDoi(encoded: string): string {
  const doi = Buffer.from(encoded, "base64url").toString("utf8");
  if (!DOI_PATTERN.test(doi) || encodeDoi(doi) !== encoded) throw new Error("invalid Unpaywall version_id");
  return doi;
}

function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    return url.href;
  } catch {
    return null;
  }
}

function locations(record: UnpaywallRecord): Array<UnpaywallLocation & { url_for_pdf: string }> {
  if (record.is_oa !== true) return [];
  return (Array.isArray(record.oa_locations) ? record.oa_locations : []).flatMap((location) => {
    const pdf = httpsUrl(location.url_for_pdf);
    return pdf ? [{ ...location, url_for_pdf: pdf }] : [];
  }).slice(0, MAX_VERSIONS_PER_CANDIDATE);
}

function versionLabel(location: UnpaywallLocation): string {
  const version = location.version === "publishedVersion"
    ? "Published version"
    : location.version === "acceptedVersion"
      ? "Accepted manuscript"
      : location.version === "submittedVersion"
        ? "Submitted manuscript"
        : "Open-access copy";
  const host = location.repository_institution?.trim() ||
    (location.host_type === "publisher" ? "Publisher" : "Repository");
  return `${version} — ${host}`;
}

function normalize(record: UnpaywallRecord): OpenPaperCandidate | null {
  const doi = record.doi?.trim().toLowerCase();
  const title = record.title?.trim();
  if (!doi || !DOI_PATTERN.test(doi) || !title) return null;
  const metadata: OpenPaperMetadata = {
    title,
    authors: (Array.isArray(record.z_authors) ? record.z_authors : [])
      .map((author) => [author.given, author.family].filter(Boolean).join(" "))
      .filter(Boolean)
      .join(", "),
    year: record.year === null || record.year === undefined ? null : String(record.year),
    journal: record.journal_name?.trim() || null,
    doi,
    pmid: null,
    pmcid: null,
  };
  const versions = locations(record).map((location): OpenPaperVersion => ({
    versionId: `unpaywall:${encodeDoi(doi)}:pdf:${fingerprint(location.url_for_pdf)}`,
    label: versionLabel(location),
    license: location.license?.trim() || null,
    source: "Unpaywall",
    // Provider landing URLs can contain short-lived access tokens. The DOI URL
    // is stable, useful to the caller, and does not disclose the download route.
    landingPage: `https://doi.org/${doi}`,
  }));
  return { candidateId: `unpaywall:${doi}`, metadata, versions };
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await boundedResponseBody(response, MAX_METADATA_BYTES);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

export class UnpaywallClient {
  readonly sourceName = "Unpaywall";
  private readonly downloadPdf: PdfDownloader;

  constructor(
    private readonly email: string,
    maxPdfBytes: number,
    private readonly fetcher: Fetcher = fetch,
    downloader?: PdfDownloader,
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
    const records = DOI_PATTERN.test(normalized)
      ? [await this.doiRecord(normalized.toLowerCase())]
      : await this.titleRecords(normalized);
    return {
      query: normalized,
      candidates: records
        .filter((record): record is UnpaywallRecord => record !== null)
        .map(normalize)
        .filter((candidate): candidate is OpenPaperCandidate => candidate !== null)
        .slice(0, 5),
    };
  }

  async download(versionId: string): Promise<DownloadedOpenPdf> {
    const match = VERSION_ID.exec(versionId);
    if (!match?.[1] || !match[2]) throw new Error("invalid Unpaywall version_id");
    const doi = decodeDoi(match[1]);
    const expectedFingerprint = match[2];
    const record = await this.doiRecord(doi);
    const candidate = record ? normalize(record) : null;
    const location = record
      ? locations(record).find((item) => fingerprint(item.url_for_pdf) === expectedFingerprint)
      : undefined;
    const version = candidate?.versions.find((item) => item.versionId === versionId);
    if (!candidate || !location || !version) {
      throw new Error("the selected Unpaywall PDF version is no longer available");
    }
    const pdf = await this.downloadPdf(location.url_for_pdf);
    return { ...pdf, metadata: candidate.metadata, version };
  }

  private async doiRecord(doi: string): Promise<UnpaywallRecord | null> {
    const url = new URL(`/v2/${encodeURIComponent(doi)}`, API_ORIGIN);
    url.searchParams.set("email", this.email);
    const response = await this.request(url);
    if (response.status === 404) {
      await cancelResponseBody(response);
      return null;
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`Unpaywall DOI request failed with HTTP ${response.status}`);
    }
    return await boundedJson(response) as UnpaywallRecord;
  }

  private async titleRecords(title: string): Promise<UnpaywallRecord[]> {
    const url = new URL("/v2/search", API_ORIGIN);
    url.searchParams.set("query", title);
    url.searchParams.set("is_oa", "true");
    url.searchParams.set("email", this.email);
    const response = await this.request(url);
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`Unpaywall title request failed with HTTP ${response.status}`);
    }
    const data = await boundedJson(response) as UnpaywallSearchResponse;
    return (Array.isArray(data.results) ? data.results : []).flatMap((result) => result.response ? [result.response] : []);
  }

  private async request(url: URL): Promise<Response> {
    const response = await this.fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await cancelResponseBody(response);
      throw new Error("Unpaywall metadata request returned an unexpected redirect");
    }
    return response;
  }
}
