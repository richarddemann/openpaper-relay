import assert from "node:assert/strict";
import test from "node:test";
import { OpenAlexClient } from "../src/openalex.js";
import { makePdf } from "./fixture.js";

const work = {
  id: "https://openalex.org/W123",
  doi: "https://doi.org/10.1234/example",
  title: "A repository copy",
  publication_year: 2024,
  authorships: [{ author: { display_name: "Ada Lovelace" } }],
  locations: [
    { is_oa: true, pdf_url: "https://repository.example/paper.pdf", license: "cc-by" },
    { is_oa: false, pdf_url: "https://publisher.example/closed.pdf" },
    { is_oa: true, pdf_url: "http://repository.example/insecure.pdf" },
  ],
};

test("OpenAlex resolves DOI metadata and rechecks the selected PDF without leaking the API key", async () => {
  const requests: URL[] = [];
  const client = new OpenAlexClient(30_000_000, "test-key", async (input, options) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-key");
    assert.equal(url.searchParams.has("api_key"), false);
    return Response.json(url.pathname === "/works" ? { results: [work] } : work);
  }, async (url) => {
    assert.equal(url, "https://repository.example/paper.pdf");
    return { data: makePdf(), filename: "paper.pdf" };
  });
  const result = await client.search("10.1234/example");
  assert.equal(requests[0]?.searchParams.get("filter"), "doi:https://doi.org/10.1234/example");
  assert.equal(result.candidates[0]?.metadata.authors, "Ada Lovelace");
  assert.equal(result.candidates[0]?.versions.length, 1);
  const pdf = await client.download(result.candidates[0]!.versions[0]!.versionId);
  assert.equal(requests[1]?.pathname, "/works/W123");
  assert.equal(pdf.metadata.doi, "10.1234/example");
  assert.doesNotMatch(JSON.stringify(result), /test-key/);
});

test("OpenAlex title search needs no key and skips identifiers owned by other sources", async () => {
  let calls = 0;
  const client = new OpenAlexClient(30_000_000, undefined, async (input, options) => {
    calls++;
    assert.equal(new URL(String(input)).searchParams.get("search"), work.title);
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    return Response.json({ results: [work] });
  });
  assert.equal((await client.search(work.title)).candidates.length, 1);
  for (const id of ["PMC123", "12345678", "1706.03762", "arxiv:hep-th/9901001"]) {
    assert.deepEqual((await client.search(id)).candidates, []);
  }
  assert.equal(calls, 1);
});

test("OpenAlex rejects forged and stale versions before downloading", async () => {
  let requests = 0;
  const client = new OpenAlexClient(30_000_000, undefined, async () => {
    requests++;
    return Response.json(work);
  }, async () => { throw new Error("must not download"); });
  await assert.rejects(client.download("https://example.com/paper.pdf"), /invalid/);
  assert.equal(requests, 0);
  await assert.rejects(client.download(`openalex:W123:pdf:${"0".repeat(64)}`), /no longer available/);
});

test("OpenAlex reports HTTP failures and bounds metadata", async () => {
  for (const status of [302, 401, 429, 500]) {
    const client = new OpenAlexClient(30_000_000, undefined, async () => new Response(null, { status }));
    await assert.rejects(client.search(work.title), new RegExp(`HTTP ${status}`));
  }
  const missing = new OpenAlexClient(30_000_000, undefined, async () => new Response(null, { status: 404 }));
  assert.deepEqual((await missing.search("10.1234/missing")).candidates, []);
  const oversized = new OpenAlexClient(30_000_000, undefined, async () => new Response(" ".repeat(2_000_001)));
  await assert.rejects(oversized.search(work.title), /size limit/);
});
