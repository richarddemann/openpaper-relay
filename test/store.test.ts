import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperStore } from "../src/store.js";
import { makePdf } from "./fixture.js";

test("store returns a content-derived ID and reads only the matching PDF", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-store-"));
  const store = new PaperStore(root, 1_000_000);
  const paper = await store.put(makePdf(), "../Unsafe Name.pdf");
  assert.match(paper.paperId, /^[a-f0-9]{64}$/);
  assert.equal(paper.filename, "Unsafe Name.pdf");
  assert.deepEqual(await store.read(paper.paperId), makePdf());
  await assert.rejects(store.read("../../etc/passwd"), /invalid paper_id/);
  assert.equal((await stat(paper.path)).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test("store rejects HTML and oversized content presented as a PDF", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-store-"));
  const store = new PaperStore(root, 100_000);
  await assert.rejects(store.put(Buffer.from("<html>login</html>")), /too small|signature/);
  const oversized = Buffer.concat([makePdf(), Buffer.alloc(100_001)]);
  await assert.rejects(store.put(oversized), /exceeds/);
});

test("content deduplication preserves provenance from every retrieval", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-store-provenance-"));
  const store = new PaperStore(root, 1_000_000);
  const pdf = makePdf("same bytes");
  const first = await store.put(pdf, "first.pdf", { provider: "Source One" });
  await store.put(pdf, "second.pdf", { provider: "Source Two" });

  const metadata = JSON.parse(
    await readFile(join(root, "metadata", `${first.paperId}.json`), "utf8"),
  ) as { filename: string; provenance: Array<{ sourceMetadata?: { provider?: string } }> };
  assert.equal(metadata.filename, "first.pdf");
  assert.deepEqual(metadata.provenance.map((entry) => entry.sourceMetadata?.provider), ["Source One", "Source Two"]);
});
