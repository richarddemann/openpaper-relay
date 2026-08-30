import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PdfTextExtractor } from "../src/extractor.js";
import { PaperStore } from "../src/store.js";
import { makePdf } from "./fixture.js";

test("text extraction runs out of process and returns paper text", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-extract-"));
  const paper = await new PaperStore(root, 1_000_000).put(makePdf("Known fixture sentence"));
  const result = await new PdfTextExtractor(15_000, 128).extract(paper.path);
  assert.match(result.text, /Known fixture sentence/);
  assert.equal(result.pages, 1);
});

test("text extraction enforces timeout and output limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-extract-"));
  const paper = await new PaperStore(root, 1_000_000).put(makePdf("Output limit fixture"));
  await assert.rejects(new PdfTextExtractor(1, 128).extract(paper.path), /exceeded 1 ms/);
  await assert.rejects(new PdfTextExtractor(15_000, 128, 8).extract(paper.path), /output limit/);
});
