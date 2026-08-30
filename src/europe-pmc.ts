import { createHash } from "node:crypto";
import { boundedResponseBody } from "./http.js";
import { filenameFromContentDisposition, safeFilename } from "./security.js";
import { validatePdf } from "./pdf.js";

const API_ORIGIN = "https://www.ebi.ac.uk";
const API_PATH = "/europepmc/webservices/rest/search";
const PDF_ORIGIN = "https://europepmc.org";
const VERSION_ID = /^(PMC\d+):pdf:([a-f0-9]{64})$/;
const MAX_METADATA_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_VERSIONS_PER_CANDIDATE = 10;

type Fetcher = typeof fetch;

interface EuropePmcFullTextUrl {
  availability?: string;
  availabilityCode?: string;
  documentStyle?: string;
  site?: string;
  url?: string;
}

interface EuropePmcRecord {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  pubYear?: string;
  journalInfo?: { journal?: { title?: string } };
  fullTextUrlList?: { fullTextUrl?: EuropePmcFullTextUrl[] };
  isOpenAccess?: string;
  hasPDF?: string;
  license?: string;
}

interface EuropePmcResponse {
  resultList?: { result?: EuropePmcRecord[] };
}

export interface OpenPaperMetadata {
  title: string;
  authors: string;
  year: string | null;
  journal: string | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
}

export interface OpenPaperVersion {
  versionId: string;
  label: string;
  license: string | null;
  source: string;
  landingPage: string;
}

export interface OpenPaperCandidate {
  candidateId: string;
  metadata: OpenPaperMetadata;
  versions: OpenPaperVersion[];
}

export interface OpenPaperSearchResult {
  query: string;
  candidates: OpenPaperCandidate[];
}

export interface DownloadedOpenPdf {
  data: Buffer;
  filename: string;
  metadata: OpenPaperMetadata;
  version: OpenPaperVersion;
}

function array(value: EuropePmcFullTextUrl[] | undefined): EuropePmcFullTextUrl[] {
  return Array.isArray(value) ? value : [];
}

function nonempty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function pdfLocations(record: EuropePmcRecord): EuropePmcFullTextUrl[] {
  const pmcid = record.pmcid;
  if (record.isOpenAccess !== "Y" || record.hasPDF !== "Y" || !pmcid) return [];
  return array(record.fullTextUrlList?.fullTextUrl).filter(
    (location) => {
      if (
        location.availabilityCode !== "OA" ||
        location.documentStyle?.toLowerCase() !== "pdf" ||
        typeof location.url !== "string"
      ) return false;
      try {
        assertEuropePmcPdfUrl(location.url, pmcid);
        return true;
      } catch {
        return false;
      }
    },
  ).slice(0, MAX_VERSIONS_PER_CANDIDATE);
}

function versionFingerprint(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function normalizeRecord(record: EuropePmcRecord): OpenPaperCandidate | null {
  const title = nonempty(record.title);
  const source = nonempty(record.source);
  const id = nonempty(record.id);
  if (!title || !source || !id) return null;
  const pmcid = nonempty(record.pmcid);
  const landingPage =
    array(record.fullTextUrlList?.fullTextUrl).find(
      (location) => location.availabilityCode === "OA" && location.documentStyle?.toLowerCase() === "html",
    )?.url ?? (pmcid ? `${PDF_ORIGIN}/articles/${pmcid}` : `${PDF_ORIGIN}/article/${source}/${id}`);
  const metadata: OpenPaperMetadata = {
    title,
    authors: nonempty(record.authorString) ?? "",
    year: nonempty(record.pubYear),
    journal: nonempty(record.journalInfo?.journal?.title),
    doi: nonempty(record.doi),
    pmid: nonempty(record.pmid),
    pmcid,
  };
  const versions = pdfLocations(record).map((location): OpenPaperVersion => ({
    versionId: `${pmcid}:pdf:${versionFingerprint(String(location.url))}`,
    label: "Europe PMC open-access PDF",
    license: nonempty(record.license),
    source: "Europe PMC",
    landingPage,
  }));
  return { candidateId: `${source}:${id}`, metadata, versions };
}

function assertEuropePmcPdfUrl(value: string, expectedPmcid: string): URL {
  const url = new URL(value);
  if (url.origin !== PDF_ORIGIN || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Europe PMC returned a PDF URL outside its fixed HTTPS origin");
  }
  const normalizedPmcid = expectedPmcid.toUpperCase();
  const articlePathMatches =
    url.pathname === `/articles/${normalizedPmcid}` || url.pathname === `/articles/${normalizedPmcid}/`;
  const apiPathMatches =
    url.pathname === "/api/getPdf" && url.searchParams.get("pmcid")?.toUpperCase() === normalizedPmcid;
  if (!articlePathMatches && !apiPathMatches) {
    if (url.pathname.startsWith("/articles/PMC") || url.pathname === "/api/getPdf") {
      throw new Error("Europe PMC PDF URL does not match the selected PMCID");
    }
    throw new Error("Europe PMC returned an unexpected PDF path");
  }
  return url;
}

export class EuropePmcClient {
  readonly sourceName = "Europe PMC";

  constructor(
    private readonly maxPdfBytes: number,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  accepts(versionId: string): boolean {
    return VERSION_ID.test(versionId);
  }

  async search(query: string): Promise<OpenPaperSearchResult> {
    const normalized = query.trim();
    if (normalized.length < 3 || normalized.length > 500) {
      throw new Error("paper query must contain between 3 and 500 characters");
    }
    const records = await this.records(normalized, 5);
    return {
      query: normalized,
      candidates: records.map(normalizeRecord).filter((candidate): candidate is OpenPaperCandidate => candidate !== null),
    };
  }

  async download(versionId: string): Promise<DownloadedOpenPdf> {
    const match = VERSION_ID.exec(versionId);
    if (!match) throw new Error("invalid Europe PMC version_id");
    const pmcid = match[1];
    const fingerprint = match[2];
    if (!pmcid || !fingerprint) throw new Error("invalid Europe PMC version_id");

    const record = (await this.records(pmcid, 5)).find((candidate) => candidate.pmcid === pmcid);
    const candidate = record ? normalizeRecord(record) : null;
    const location = record
      ? pdfLocations(record).find((candidateLocation) => versionFingerprint(String(candidateLocation.url)) === fingerprint)
      : undefined;
    const version = candidate?.versions.find((candidateVersion) => candidateVersion.versionId === versionId);
    if (!candidate || !location?.url || !version) {
      throw new Error("the selected open-access PDF version is no longer available");
    }

    const response = await this.fetchPdf(location.url, pmcid);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/pdf")) throw new Error("Europe PMC did not return a PDF response");
    const data = await boundedResponseBody(response, this.maxPdfBytes);
    validatePdf(data, this.maxPdfBytes);
    return {
      data,
      filename: safeFilename(filenameFromContentDisposition(response.headers.get("content-disposition"))),
      metadata: candidate.metadata,
      version,
    };
  }

  private async records(query: string, pageSize: number): Promise<EuropePmcRecord[]> {
    const url = new URL(API_PATH, API_ORIGIN);
    url.searchParams.set("query", query);
    url.searchParams.set("resultType", "core");
    url.searchParams.set("format", "json");
    url.searchParams.set("pageSize", String(pageSize));
    const response = await this.fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error("Europe PMC metadata request returned an unexpected redirect");
    }
    if (!response.ok) throw new Error(`Europe PMC metadata request failed with HTTP ${response.status}`);
    const data = JSON.parse((await boundedResponseBody(response, MAX_METADATA_BYTES)).toString("utf8")) as EuropePmcResponse;
    return Array.isArray(data.resultList?.result) ? data.resultList.result : [];
  }

  private async fetchPdf(initialUrl: string, expectedPmcid: string): Promise<Response> {
    let url = assertEuropePmcPdfUrl(initialUrl, expectedPmcid);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await this.fetcher(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/pdf" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Europe PMC returned a redirect without a location");
        url = assertEuropePmcPdfUrl(new URL(location, url).href, expectedPmcid);
        continue;
      }
      if (!response.ok) throw new Error(`Europe PMC PDF request failed with HTTP ${response.status}`);
      return response;
    }
    throw new Error("Europe PMC PDF request exceeded the redirect limit");
  }
}
