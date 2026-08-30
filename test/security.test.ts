import assert from "node:assert/strict";
import test from "node:test";
import type { Lookup } from "../src/security.js";
import {
  assertAllowedDownloadUrl,
  assertAllowedRequestUrl,
  assertAllowedUrl,
  hostIsAllowed,
  ipIsPublic,
  normalizeIdentifier,
  safeFilename,
} from "../src/security.js";

const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as Lookup;
const privateLookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as Lookup;

test("DOI input is encoded into the configured resolver", () => {
  const url = normalizeIdentifier("10.1234/a.b", "https://resolver.example.edu/?doi={doi}");
  assert.equal(url.kind, "doi");
  assert.equal(url.url.href, "https://resolver.example.edu/?doi=10.1234%2Fa.b");
});

test("browser request policy rejects redirect ports and credentials", () => {
  assert.equal(assertAllowedRequestUrl("https://publisher.example/paper", ["publisher.example"]).hostname, "publisher.example");
  assert.throws(() => assertAllowedRequestUrl("https://publisher.example:8443/paper", ["publisher.example"]), /non-standard/);
  assert.throws(() => assertAllowedRequestUrl("https://user:secret@publisher.example/paper", ["publisher.example"]), /credentials/);
});

test("download policy accepts an allowlisted blob origin but rejects other blob origins", async () => {
  await assert.doesNotReject(
    assertAllowedDownloadUrl("blob:https://pdf.publisher.example/00d7", ["pdf.publisher.example"], publicLookup),
  );
  await assert.rejects(
    assertAllowedDownloadUrl("blob:https://evil.example/00d7", ["pdf.publisher.example"], publicLookup),
    /non-allowlisted/,
  );
});

test("URL input rejects credentials and non-HTTPS protocols", () => {
  assert.throws(() => normalizeIdentifier("http://publisher.example/paper", "https://resolver.example/{doi}"), /HTTPS/);
  assert.throws(() => normalizeIdentifier("https://name:secret@publisher.example/paper", "https://resolver.example/{doi}"), /credentials/);
});

test("host allowlist is exact and does not grant subdomains", () => {
  assert.equal(hostIsAllowed("publisher.example", ["publisher.example"]), true);
  assert.equal(hostIsAllowed("evil.publisher.example", ["publisher.example"]), false);
});

test("URL policy rejects literal, private, unlisted, and nonstandard targets", async () => {
  await assert.rejects(assertAllowedUrl("https://127.0.0.1/paper", ["127.0.0.1"], publicLookup), /literal IP/);
  await assert.rejects(assertAllowedUrl("https://publisher.example/paper", ["publisher.example"], privateLookup), /non-public/);
  await assert.rejects(assertAllowedUrl("https://other.example/paper", ["publisher.example"], publicLookup), /non-allowlisted/);
  await assert.rejects(assertAllowedUrl("https://publisher.example:8443/paper", ["publisher.example"], publicLookup), /non-standard/);
});

test("public IP classification rejects private, loopback, link-local, and reserved ranges", () => {
  assert.equal(ipIsPublic("93.184.216.34"), true);
  for (const value of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "192.168.1.1", "::1", "fd00::1", "2001:db8::1"]) {
    assert.equal(ipIsPublic(value), false, value);
  }
});

test("filenames cannot escape the document directory", () => {
  assert.equal(safeFilename("../../secret?.PDF"), "secret_.PDF");
  assert.equal(safeFilename(undefined), "paper.pdf");
});
