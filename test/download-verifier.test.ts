import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DownloadedPaperVerifier } from "../src/download-verifier.js";
import { PdfTextExtractor } from "../src/extractor.js";
import { makePdf } from "./fixture.js";

test("extracts a downloaded PDF in private temporary storage and removes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpaper-verifier-"));
  try {
    const verifier = new DownloadedPaperVerifier(root, new PdfTextExtractor(10_000, 128));
    const verification = await verifier.verify(
      makePdf("Verified Article Ada Lovelace 2024 doi: 10.1234/verified"),
      { doi: "10.1234/verified", title: "Verified Article", authors: "Ada Lovelace", year: "2024" },
    );

    assert.equal(verification.status, "verified");
    assert.deepEqual(await readdir(join(root, "verification")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports extraction failures as inconclusive without leaking parser details", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpaper-verifier-"));
  try {
    const verifier = new DownloadedPaperVerifier(root, {
      extract: async () => { throw new Error("sensitive parser diagnostic"); },
    });
    const verification = await verifier.verify(makePdf(), { doi: "10.1234/example" });

    assert.equal(verification.status, "inconclusive");
    assert.equal(verification.reason, "text_extraction_unavailable");
    assert.equal(JSON.stringify(verification).includes("sensitive"), false);
    assert.deepEqual(await readdir(join(root, "verification")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
