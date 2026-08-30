import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDeclaredPdfLength, readPdfFileWithinLimit } from "../src/pdf.js";

test("browser PDF responses require a valid bounded declared content length", () => {
  assert.equal(assertDeclaredPdfLength("128", 256), 128);
  assert.throws(() => assertDeclaredPdfLength(undefined, 256), /content-length/i);
  assert.throws(() => assertDeclaredPdfLength("not-a-number", 256), /content-length/i);
  assert.throws(() => assertDeclaredPdfLength("257", 256), /size limit/i);
});

test("browser downloads are rejected before an oversized file is read", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpaper-relay-browser-download-"));
  const path = join(root, "oversized.pdf");
  await writeFile(path, Buffer.alloc(257, 0x41));

  await assert.rejects(readPdfFileWithinLimit(path, 256), /size limit/i);
});
