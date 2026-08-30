import assert from "node:assert/strict";
import test from "node:test";
import { createPinnedLookup, SecurePdfDownloader } from "../src/secure-download.js";

test("secure downloader rejects non-HTTPS, credentials, ports, and private targets", async () => {
  const downloader = new SecurePdfDownloader(30_000_000);
  await assert.rejects(downloader.download("http://example.com/paper.pdf"), /must be an HTTPS URL/);
  await assert.rejects(downloader.download("https://user:secret@example.com/paper.pdf"), /must be an HTTPS URL/);
  await assert.rejects(downloader.download("https://example.com:8443/paper.pdf"), /must be an HTTPS URL/);
  await assert.rejects(downloader.download("https://127.0.0.1/paper.pdf"), /non-public address/);
});

test("pinned DNS lookup supports Node single-address and all-address callbacks", async () => {
  const pinned = createPinnedLookup({ address: "203.0.113.10", family: 4 });
  const single = await new Promise<unknown[]>((resolve, reject) => {
    (pinned as unknown as Function)("example.com", { all: false }, (error: Error | null, ...values: unknown[]) => {
      if (error) reject(error); else resolve(values);
    });
  });
  const all = await new Promise<unknown[]>((resolve, reject) => {
    (pinned as unknown as Function)("example.com", { all: true }, (error: Error | null, ...values: unknown[]) => {
      if (error) reject(error); else resolve(values);
    });
  });

  assert.deepEqual(single, ["203.0.113.10", 4]);
  assert.deepEqual(all, [[{ address: "203.0.113.10", family: 4 }]]);
});

test("secure downloader bounds DNS resolution time", async () => {
  const downloader = new SecurePdfDownloader(
    30_000_000,
    30_000,
    async () => new Promise(() => undefined),
    10,
  );

  await assert.rejects(downloader.download("https://example.com/paper.pdf"), /DNS resolution timed out/);
});
