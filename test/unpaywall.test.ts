import assert from "node:assert/strict";
import test from "node:test";
import { UnpaywallClient } from "../src/unpaywall.js";
import { makePdf } from "./fixture.js";

const record = {
  doi: "10.1234/example",
  title: "A lawful repository copy",
  year: 2024,
  journal_name: "Journal of Examples",
  z_authors: [{ given: "Ada", family: "Lovelace" }],
  is_oa: true,
  oa_locations: [
    {
      host_type: "repository",
      version: "acceptedVersion",
      license: "cc-by",
      repository_institution: "Example University",
      url_for_landing_page: "https://repository.example.edu/items/123",
      url_for_pdf: "https://repository.example.edu/paper.pdf",
    },
    {
      host_type: "publisher",
      version: "publishedVersion",
      license: null,
      url_for_landing_page: "https://publisher.example/article",
      url_for_pdf: null,
    },
  ],
};

test("Unpaywall DOI lookup returns normalized legal PDF versions", async () => {
  const requested: URL[] = [];
  const client = new UnpaywallClient(
    "reader@example.edu",
    30_000_000,
    async (input) => {
      requested.push(new URL(String(input)));
      return Response.json(record);
    },
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
  );

  const result = await client.search("10.1234/example");

  assert.equal(requested[0]?.pathname, "/v2/10.1234%2Fexample");
  assert.equal(requested[0]?.searchParams.get("email"), "reader@example.edu");
  assert.equal(result.candidates[0]?.metadata.authors, "Ada Lovelace");
  assert.deepEqual(result.candidates[0]?.versions, [
    {
      versionId:
        "unpaywall:MTAuMTIzNC9leGFtcGxl:pdf:efd77fd918c240b0a6f1fcbad93a5a19f5f74c1382b08efddb0adc12c72816f4",
      label: "Accepted manuscript — Example University",
      license: "cc-by",
      source: "Unpaywall",
      landingPage: "https://repository.example.edu/items/123",
    },
  ]);
});

test("Unpaywall title lookup uses the OA-only search endpoint", async () => {
  const requested: URL[] = [];
  const client = new UnpaywallClient(
    "reader@example.edu",
    30_000_000,
    async (input) => {
      requested.push(new URL(String(input)));
      return Response.json({ results: [{ response: record, score: 1 }] });
    },
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
  );

  const result = await client.search("A lawful repository copy");

  assert.equal(requested[0]?.pathname, "/v2/search");
  assert.equal(requested[0]?.searchParams.get("is_oa"), "true");
  assert.equal(result.candidates[0]?.metadata.doi, "10.1234/example");
});

test("Unpaywall download re-resolves the opaque version before fetching", async () => {
  const downloadedUrls: string[] = [];
  const client = new UnpaywallClient(
    "reader@example.edu",
    30_000_000,
    async () => Response.json(record),
    async (url) => {
      downloadedUrls.push(url);
      return { data: makePdf("Unpaywall fixture"), filename: "repository.pdf" };
    },
  );

  const result = await client.download(
    "unpaywall:MTAuMTIzNC9leGFtcGxl:pdf:efd77fd918c240b0a6f1fcbad93a5a19f5f74c1382b08efddb0adc12c72816f4",
  );

  assert.deepEqual(downloadedUrls, ["https://repository.example.edu/paper.pdf"]);
  assert.equal(result.filename, "repository.pdf");
  assert.equal(result.metadata.doi, "10.1234/example");
});

test("Unpaywall rejects arbitrary URLs and stale version fingerprints", async () => {
  const client = new UnpaywallClient(
    "reader@example.edu",
    30_000_000,
    async () => Response.json({ ...record, oa_locations: [] }),
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
  );
  await assert.rejects(client.download("https://attacker.example/paper.pdf"), /invalid Unpaywall version_id/);
  await assert.rejects(
    client.download(
      "unpaywall:MTAuMTIzNC9leGFtcGxl:pdf:efd77fd918c240b0a6f1fcbad93a5a19f5f74c1382b08efddb0adc12c72816f4",
    ),
    /no longer available/,
  );
});

test("Unpaywall stops reading oversized metadata responses", async () => {
  const client = new UnpaywallClient(
    "reader@example.edu",
    30_000_000,
    async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_500_000));
        controller.enqueue(new Uint8Array(1_500_000));
        controller.close();
      },
    })),
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
  );

  await assert.rejects(client.search("10.1234/example"), /response exceeds configured size limit/);
});

test("Unpaywall caps the number of advertised PDF versions", async () => {
  const manyLocations = Array.from({ length: 20 }, (_, index) => ({
    ...record.oa_locations[0],
    url_for_pdf: `https://repository.example.edu/paper-${index}.pdf`,
  }));
  const client = new UnpaywallClient(
    "reader@example.edu",
    30_000_000,
    async () => Response.json({ ...record, oa_locations: manyLocations }),
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
  );

  const result = await client.search("10.1234/example");

  assert.equal(result.candidates[0]?.versions.length, 10);
});
