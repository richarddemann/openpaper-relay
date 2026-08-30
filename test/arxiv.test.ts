import assert from "node:assert/strict";
import test from "node:test";
import { ArxivClient } from "../src/arxiv.js";
import { makePdf } from "./fixture.js";

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-02-02T00:00:00Z</updated>
    <published>2024-01-20T00:00:00Z</published>
    <title>A Secure Preprint Example</title>
    <author><name>Ada Lovelace</name></author>
    <author><name>Grace Hopper</name></author>
    <arxiv:doi>10.1234/example</arxiv:doi>
    <arxiv:license href="https://creativecommons.org/licenses/by/4.0/" />
    <link href="http://arxiv.org/abs/2401.12345v2" rel="alternate" type="text/html" />
    <link title="pdf" href="http://arxiv.org/pdf/2401.12345v2" rel="related" type="application/pdf" />
    <link title="pdf" href="https://attacker.example/paper.pdf" rel="related" type="application/pdf" />
  </entry>
</feed>`;

function atomResponse(): Response {
  return new Response(atom, { headers: { "content-type": "application/atom+xml" } });
}

test("arXiv title search returns one fixed-origin preprint version", async () => {
  const requested: URL[] = [];
  const client = new ArxivClient(
    30_000_000,
    async (input) => {
      requested.push(new URL(String(input)));
      return atomResponse();
    },
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
  );

  const result = await client.search("A Secure Preprint Example");

  assert.equal(requested[0]?.origin, "https://export.arxiv.org");
  assert.equal(requested[0]?.searchParams.get("search_query"), 'ti:"A Secure Preprint Example"');
  assert.equal(requested[0]?.searchParams.get("max_results"), "5");
  assert.equal(result.candidates[0]?.metadata.authors, "Ada Lovelace, Grace Hopper");
  assert.deepEqual(result.candidates[0]?.versions, [
    {
      versionId:
        "arxiv:MjQwMS4xMjM0NXYy:pdf:f8d16372efab622f323382fa38529cd36bde2a434fa64a9d2efaf0a01e533fbe",
      label: "arXiv v2 preprint",
      license: "https://creativecommons.org/licenses/by/4.0/",
      source: "arXiv",
      landingPage: "https://arxiv.org/abs/2401.12345v2",
    },
  ]);
});

test("arXiv download re-resolves the versioned identifier", async () => {
  const downloadedUrls: string[] = [];
  const client = new ArxivClient(
    30_000_000,
    async () => atomResponse(),
    async (url) => {
      downloadedUrls.push(url);
      return { data: makePdf("arXiv fixture"), filename: "2401.12345v2.pdf" };
    },
  );

  const result = await client.download(
    "arxiv:MjQwMS4xMjM0NXYy:pdf:f8d16372efab622f323382fa38529cd36bde2a434fa64a9d2efaf0a01e533fbe",
  );

  assert.deepEqual(downloadedUrls, ["https://arxiv.org/pdf/2401.12345v2"]);
  assert.equal(result.metadata.doi, "10.1234/example");
});

test("arXiv rejects arbitrary and stale version IDs", async () => {
  const client = new ArxivClient(
    30_000_000,
    async () => new Response(atom.replace("2401.12345v2", "2401.99999v1")),
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
  );
  await assert.rejects(client.download("https://attacker.example/paper.pdf"), /invalid arXiv version_id/);
  await assert.rejects(
    client.download(
      "arxiv:MjQwMS4xMjM0NXYy:pdf:f8d16372efab622f323382fa38529cd36bde2a434fa64a9d2efaf0a01e533fbe",
    ),
    /no longer available/,
  );
});

test("arXiv retries one rate-limited metadata request", async () => {
  let calls = 0;
  const client = new ArxivClient(
    30_000_000,
    async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : atomResponse();
    },
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
    0,
  );

  const result = await client.search("2401.12345v2");

  assert.equal(calls, 2);
  assert.equal(result.candidates[0]?.candidateId, "arxiv:2401.12345v2");
});

test("arXiv reuses a just-searched record for the immediate download", async () => {
  let metadataCalls = 0;
  const client = new ArxivClient(
    30_000_000,
    async () => {
      metadataCalls += 1;
      return atomResponse();
    },
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
    0,
  );

  const search = await client.search("2401.12345v2");
  await client.download(search.candidates[0]!.versions[0]!.versionId);

  assert.equal(metadataCalls, 1);
});

test("arXiv bounds its short-lived record cache", async () => {
  let metadataCalls = 0;
  let firstVersionId = "";
  const client = new ArxivClient(
    30_000_000,
    async (input) => {
      metadataCalls += 1;
      const id = new URL(String(input)).searchParams.get("id_list") ?? "2401.00000v2";
      return new Response(atom.replaceAll("2401.12345v2", id));
    },
    async () => ({ data: makePdf(), filename: "paper.pdf" }),
    0,
  );

  for (let index = 0; index <= 100; index += 1) {
    const id = `2401.${String(index).padStart(5, "0")}v2`;
    const search = await client.search(id);
    if (index === 0) firstVersionId = search.candidates[0]!.versions[0]!.versionId;
  }
  await client.download(firstVersionId);

  assert.equal(metadataCalls, 102);
});
