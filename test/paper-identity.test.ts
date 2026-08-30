import assert from "node:assert/strict";
import test from "node:test";
import { verifyPaperIdentity } from "../src/paper-identity.js";

const expected = {
  doi: "10.1234/Example.42",
  title: "A Deterministic Check for Research Paper Identity",
  authors: "Ada Lovelace, Alan Turing",
  year: "2024",
};

test("verifies an expected DOI in front matter after normalizing its URL form", () => {
  const result = verifyPaperIdentity(
    "A Deterministic Check for Research Paper Identity\nAda Lovelace\nhttps://doi.org/10.1234/example.42.\n2024",
    expected,
  );

  assert.equal(result.status, "verified");
  assert.equal(result.method, "doi");
  assert.equal(result.doiMatched, true);
});

test("allows a labeled DOI alone only when no title metadata is available", () => {
  const result = verifyPaperIdentity("doi: 10.1234/example.42", { doi: expected.doi });

  assert.equal(result.status, "verified");
  assert.equal(result.method, "doi");
});

test("does not verify a wrong article that only labels the requested DOI as related", () => {
  const result = verifyPaperIdentity(
    "Wrong Article\nGrace Hopper\n2020\nRelated DOI: 10.1234/example.42",
    expected,
  );

  assert.equal(result.status, "inconclusive");
});

test("tolerates one typesetting-split title token when DOI, author, and year agree", () => {
  const result = verifyPaperIdentity(
    "The bZIP transcription factor Rca1p is a central regulator of a novel CO 2 sensing pathway in yeast\nCottier F\n2012\nhttps://doi.org/10.1371/journal.ppat.1002485",
    {
      doi: "10.1371/journal.ppat.1002485",
      title: "The bZIP transcription factor Rca1p is a central regulator of a novel CO₂ sensing pathway in yeast",
      authors: "Cottier F, Raymond M",
      year: "2012",
    },
  );

  assert.equal(result.status, "verified");
});

test("does not verify a title with an inserted distinguishing modifier", () => {
  const result = verifyPaperIdentity(
    "A Deterministic Check for Clinical Research Paper Identity\nAda Lovelace\n2024\ndoi: 10.1234/example.42",
    expected,
  );

  assert.equal(result.status, "inconclusive");
});

test("does not verify an expected DOI that appears only in references", () => {
  const result = verifyPaperIdentity(
    `Different Article\nGrace Hopper\n2021\n${"body ".repeat(100)}References 10.1234/example.42`,
    expected,
  );

  assert.equal(result.status, "inconclusive");
});

test("verifies a wrapped title with first-author and year corroboration", () => {
  const result = verifyPaperIdentity(
    "A Deterministic Check for\nResearch Paper Identity\nAda Lovelace and colleagues\nPublished 2024",
    { ...expected, doi: null },
  );

  assert.equal(result.status, "verified");
  assert.equal(result.method, "title_author_year");
});

test("does not verify title words scattered through body text", () => {
  const result = verifyPaperIdentity(
    "Unrelated Paper by Ada Lovelace, 2024. A long deterministic discussion later mentions a check, research methods, paper records, and identity separately.",
    { ...expected, doi: null },
  );

  assert.equal(result.status, "inconclusive");
});

test("does not verify a title and author that appear only in the bibliography", () => {
  const result = verifyPaperIdentity(
    "Unrelated Short Paper\nGrace Hopper\n2021\nREFERENCES\nA Deterministic Check for Research Paper Identity. Ada Lovelace. 2024.",
    { ...expected, doi: null },
  );

  assert.equal(result.status, "inconclusive");
});

test("requires author and year corroboration for a short title", () => {
  const result = verifyPaperIdentity(
    "Deep Learning\nUnrelated Author\n2020\nThis is a long body about an unrelated subject. ".repeat(20),
    { doi: null, title: "Deep Learning", authors: "Ada Lovelace", year: "2024" },
  );

  assert.equal(result.status, "inconclusive");
});

test("marks a contradictory front-matter DOI as a mismatch", () => {
  const result = verifyPaperIdentity(
    "Completely Different Research\nGrace Hopper\n2021\ndoi: 10.9999/wrong-paper\n" + "Substantial article text. ".repeat(40),
    expected,
  );

  assert.equal(result.status, "mismatch");
  assert.equal(result.doiMatched, false);
});

test("does not reject a matching title because another labeled DOI is present", () => {
  const result = verifyPaperIdentity(
    "A Deterministic Check for Research Paper Identity\nAda Lovelace\n2024\nSupplement doi: 10.9999/supplement",
    expected,
  );

  assert.equal(result.status, "verified");
  assert.equal(result.method, "title_author_year");
});

test("keeps text-poor and scanned PDFs inconclusive", () => {
  const result = verifyPaperIdentity("Cover page", expected);

  assert.equal(result.status, "inconclusive");
  assert.equal(result.method, "none");
});
