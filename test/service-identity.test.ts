import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DownloadedOpenPdf, OpenPaperCandidate } from "../src/europe-pmc.js";
import { OpenPaperResolver, type OpenPaperSource } from "../src/open-paper-resolver.js";
import { PaperFetcherService } from "../src/service.js";
import type { AppConfig } from "../src/types.js";
import { makePdf } from "./fixture.js";

const config: AppConfig = {
  maxPdfBytes: 5_000_000,
  maxDownloadsPerHour: 10,
  maxSearchesPerHour: 20,
  extractionTimeoutMs: 10_000,
  extractionMaxOldSpaceMb: 128,
  sites: [],
};

function source(name: string, pdfText: string, events: string[]): OpenPaperSource {
  const versionId = `${name}:v1`;
  const candidate: OpenPaperCandidate = {
    candidateId: `${name}:10.1234/expected`,
    metadata: {
      title: "Expected Paper Title for Verification",
      authors: "Ada Lovelace",
      year: "2024",
      journal: "Journal",
      doi: "10.1234/expected",
      pmid: null,
      pmcid: null,
    },
    versions: [{
      versionId,
      label: `${name} PDF`,
      license: "cc-by",
      source: name,
      landingPage: `https://${name.toLowerCase()}.example/paper`,
    }],
  };
  return {
    sourceName: name,
    accepts: (value) => value === versionId,
    search: async (query) => {
      events.push(`search:${name}`);
      return { query, candidates: [candidate] };
    },
    download: async (): Promise<DownloadedOpenPdf> => {
      events.push(`download:${name}`);
      return { data: makePdf(pdfText), filename: `${name}.pdf`, metadata: candidate.metadata, version: candidate.versions[0]! };
    },
  };
}

test("automatic fallback rejects a mismatched PDF and stores the next verified copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpaper-service-"));
  try {
    const events: string[] = [];
    const service = new PaperFetcherService(config, root);
    (service as unknown as { openPapers: OpenPaperResolver }).openPapers = new OpenPaperResolver([
      source("First", "Different paper doi: 10.9999/wrong", events),
      source("Second", "Expected Paper Title for Verification Ada Lovelace 2024 doi: 10.1234/expected", events),
    ]);

    const result = await service.fetchBestOpenPaper("10.1234/expected");

    assert.equal(result.status, "downloaded");
    if (result.status === "downloaded") {
      assert.equal(result.version.source, "Second");
      assert.equal(result.verification.status, "verified");
    }
    assert.deepEqual(events, ["search:First", "download:First", "search:Second", "download:Second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns one clearly labeled inconclusive copy only after trying every open source", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpaper-service-"));
  try {
    const events: string[] = [];
    const service = new PaperFetcherService(config, root);
    (service as unknown as { openPapers: OpenPaperResolver }).openPapers = new OpenPaperResolver([
      source("First", "Cover page", events),
      source("Second", "Image only", events),
    ]);

    const result = await service.fetchBestOpenPaper("10.1234/expected");

    assert.equal(result.status, "downloaded");
    if (result.status === "downloaded") assert.equal(result.verification.status, "inconclusive");
    assert.deepEqual(events, ["search:First", "download:First", "search:Second", "download:Second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
