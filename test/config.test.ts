import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const site = {
  id: "test-site",
  label: "Test Site",
  startUrl: "https://library.example/",
  doiUrlTemplate: "https://resolver.example/?doi={doi}",
  allowedNetworkHosts: ["library.example", "resolver.example", "publisher.example", "pdf.publisher.example"],
  allowedPaperUrlHosts: ["publisher.example"],
  allowedPdfHosts: ["publisher.example", "pdf.publisher.example"],
};

async function writeConfig(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paper-config-"));
  const path = join(directory, "sites.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("configuration applies conservative defaults", async () => {
  const config = await loadConfig(await writeConfig({ sites: [site] }));
  assert.equal(config.maxPdfBytes, 30_000_000);
  assert.equal(config.maxDownloadsPerHour, 12);
  assert.equal(config.maxSearchesPerHour, 120);
  assert.deepEqual(config.sites[0]?.loginPageSelectors, ["input[type=password]"]);
});

test("configuration accepts an optional Unpaywall contact email", async () => {
  const config = await loadConfig(await writeConfig({ unpaywallEmail: "reader@example.edu", sites: [] }));
  assert.equal(config.unpaywallEmail, "reader@example.edu");
  await assert.rejects(
    loadConfig(await writeConfig({ unpaywallEmail: "not-an-email", sites: [] })),
    /email/i,
  );
});

test("a missing private-site configuration enables the built-in open-access source only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paper-config-missing-"));
  const config = await loadConfig(join(directory, "sites.local.json"));
  assert.deepEqual(config.sites, []);
  assert.equal(config.maxDownloadsPerHour, 12);
});

test("configuration rejects a resolver host missing from the exact allowlist", async () => {
  const path = await writeConfig({ sites: [{ ...site, allowedNetworkHosts: ["library.example", "publisher.example", "pdf.publisher.example"] }] });
  await assert.rejects(loadConfig(path), /resolver\.example/);
});

test("configuration rejects duplicate site IDs and unknown keys", async () => {
  await assert.rejects(loadConfig(await writeConfig({ sites: [site, site] })), /duplicate site id/);
  await assert.rejects(loadConfig(await writeConfig({ sites: [{ ...site, password: "never" }] })), /unrecognized/i);
});

test("configuration rejects wildcard, IP, and credential-bearing network policy", async () => {
  await assert.rejects(
    loadConfig(await writeConfig({ sites: [{ ...site, allowedNetworkHosts: [...site.allowedNetworkHosts, "*.publisher.example"] }] })),
    /exact DNS hostnames/,
  );
  await assert.rejects(
    loadConfig(await writeConfig({ sites: [{ ...site, allowedNetworkHosts: [...site.allowedNetworkHosts, "127.0.0.1"] }] })),
    /exact DNS hostnames/,
  );
  await assert.rejects(
    loadConfig(await writeConfig({ sites: [{ ...site, startUrl: "https://user:secret@library.example/" }] })),
    /without credentials/,
  );
});

test("paper-input and PDF trust roles must be subsets of the network policy", async () => {
  await assert.rejects(
    loadConfig(await writeConfig({ sites: [{ ...site, allowedPaperUrlHosts: ["unlisted.example"] }] })),
    /must also appear in allowedNetworkHosts/,
  );
  await assert.rejects(
    loadConfig(await writeConfig({ sites: [{ ...site, allowedPdfHosts: ["unlisted.example"] }] })),
    /must also appear in allowedNetworkHosts/,
  );
});
