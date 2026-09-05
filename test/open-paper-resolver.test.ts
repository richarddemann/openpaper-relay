import assert from "node:assert/strict";
import test from "node:test";
import type {
  DownloadedOpenPdf,
  OpenPaperCandidate,
  OpenPaperSearchResult,
  OpenPaperVersion,
} from "../src/europe-pmc.js";
import { OpenPaperResolver, type OpenPaperSource } from "../src/open-paper-resolver.js";
import { RateLimitError } from "../src/rate-limiter.js";
import { makePdf } from "./fixture.js";

function candidate(source: string, versionId: string, title = "Exact Paper Title"): OpenPaperCandidate {
  return {
    candidateId: `${source}:10.1234/example`,
    metadata: {
      title,
      authors: "Ada Lovelace",
      year: "2024",
      journal: "Journal",
      doi: "10.1234/example",
      pmid: null,
      pmcid: null,
    },
    versions: [{
      versionId,
      label: `${source} PDF`,
      license: "cc-by",
      source,
      landingPage: `https://${source.toLowerCase()}.example/paper`,
    }],
  };
}

function source(
  sourceName: string,
  result: OpenPaperCandidate[],
  events: string[],
  download: () => Promise<DownloadedOpenPdf>,
): OpenPaperSource {
  return {
    sourceName,
    accepts: (versionId) => versionId.startsWith(`${sourceName}:`),
    search: async (query): Promise<OpenPaperSearchResult> => {
      events.push(`search:${sourceName}`);
      return { query, candidates: result };
    },
    download: async () => {
      events.push(`download:${sourceName}`);
      return download();
    },
  };
}

function downloaded(version: OpenPaperVersion): DownloadedOpenPdf {
  return {
    data: makePdf(version.source),
    filename: `${version.source}.pdf`,
    metadata: candidate(version.source, version.versionId).metadata,
    version,
  };
}

test("best-paper fallback tries versions in source order until one succeeds", async () => {
  const events: string[] = [];
  const pmc = candidate("Europe PMC", "Europe PMC:v1");
  const unpaywall = candidate("Unpaywall", "Unpaywall:v1");
  const arxiv = candidate("arXiv", "arXiv:v1");
  const resolver = new OpenPaperResolver([
    source("Europe PMC", [pmc], events, async () => { throw new Error("PDF disappeared"); }),
    source("Unpaywall", [unpaywall], events, async () => downloaded(unpaywall.versions[0]!)),
    source("arXiv", [arxiv], events, async () => downloaded(arxiv.versions[0]!)),
  ]);
  const limitedDownloads: string[] = [];
  const limitedSearches: string[] = [];

  const result = await resolver.fetchBest("10.1234/example", async (selectedSource, versionId) => {
    limitedDownloads.push(selectedSource.sourceName);
    return selectedSource.download(versionId);
  }, async (selectedSource, sourceQuery) => {
    limitedSearches.push(selectedSource.sourceName);
    return selectedSource.search(sourceQuery);
  });

  assert.equal(result.status, "downloaded");
  if (result.status === "downloaded") assert.equal(result.paper.version.source, "Unpaywall");
  assert.deepEqual(events, [
    "search:Europe PMC",
    "download:Europe PMC",
    "search:Unpaywall",
    "download:Unpaywall",
  ]);
  assert.deepEqual(limitedDownloads, ["Europe PMC", "Unpaywall"]);
  assert.deepEqual(limitedSearches, ["Europe PMC", "Unpaywall"]);
});

test("best-paper fallback reports every failure after exhausting sources", async () => {
  const events: string[] = [];
  const first = candidate("First", "First:v1");
  const second = candidate("Second", "Second:v1");
  const resolver = new OpenPaperResolver([
    source("First", [first], events, async () => { throw new Error("not a PDF"); }),
    source("Second", [second], events, async () => { throw new Error("timed out"); }),
  ]);

  const result = await resolver.fetchBest("10.1234/example");

  assert.equal(result.status, "exhausted");
  assert.deepEqual(
    result.attempts.filter((attempt) => attempt.stage === "download").map((attempt) => attempt.message),
    ["not a PDF", "timed out"],
  );
});

test("ambiguous title search asks for selection and downloads nothing", async () => {
  const events: string[] = [];
  const resolver = new OpenPaperResolver([
    source("One", [candidate("One", "One:v1", "Similar Paper One")], events, async () => {
      throw new Error("must not download");
    }),
    source("Two", [candidate("Two", "Two:v1", "Similar Paper Two")], events, async () => {
      throw new Error("must not download");
    }),
  ]);

  let downloadAttempts = 0;
  const result = await resolver.fetchBest("Similar Paper", async (selectedSource, versionId) => {
    downloadAttempts += 1;
    return selectedSource.download(versionId);
  });

  assert.equal(result.status, "selection_required");
  assert.equal(events.some((event) => event.startsWith("download:")), false);
  assert.equal(downloadAttempts, 0);
});

test("an unversioned arXiv ID accepts the source's current version", async () => {
  const events: string[] = [];
  const arxiv = candidate("arXiv", "arXiv:v7");
  arxiv.candidateId = "arxiv:1706.03762v7";
  arxiv.metadata.doi = null;
  const resolver = new OpenPaperResolver([
    source("arXiv", [arxiv], events, async () => downloaded(arxiv.versions[0]!)),
  ]);

  const result = await resolver.fetchBest("1706.03762");

  assert.equal(result.status, "downloaded");
  assert.deepEqual(events, ["search:arXiv", "download:arXiv"]);
});

test("a source rate limit stops its remaining versions before trying the next source", async () => {
  const events: string[] = [];
  const first = candidate("First", "First:v1");
  first.versions.push({ ...first.versions[0]!, versionId: "First:v2" });
  const second = candidate("Second", "Second:v1");
  const resolver = new OpenPaperResolver([
    source("First", [first], events, async () => { throw new Error("must use injected downloader"); }),
    source("Second", [second], events, async () => downloaded(second.versions[0]!)),
  ]);

  const result = await resolver.fetchBest("10.1234/example", async (selectedSource, versionId) => {
    events.push(`limited:${versionId}`);
    if (selectedSource.sourceName === "First") throw new RateLimitError(1, 60 * 60 * 1000);
    return selectedSource.download(versionId);
  });

  assert.equal(result.status, "downloaded");
  assert.equal(events.includes("limited:First:v2"), false);
  assert.equal(events.includes("limited:Second:v1"), true);
});

test("DOI URLs and prefixes follow identifier lookup rather than title search", async () => {
  const { normalizePaperQuery } = await import("../src/open-paper-resolver.js");
  for (const query of ["https://doi.org/10.1234/example", "http://dx.doi.org/10.1234%2Fexample", "doi: 10.1234/example"]) {
    assert.equal(normalizePaperQuery(query), "10.1234/example");
    let received = "";
    const resolver = new OpenPaperResolver([{
      sourceName: "Fixture", accepts: () => false,
      search: async (value) => { received = value; return { query: value, candidates: [] }; },
      download: async () => { throw new Error("unused"); },
    }]);
    await resolver.fetchBest(query);
    assert.equal(received, "10.1234/example");
    await resolver.search(query);
    assert.equal(received, "10.1234/example");
  }
  assert.equal(normalizePaperQuery("A paper title"), "A paper title");
});
