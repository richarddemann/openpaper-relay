const PRIMARY_FRONT_MATTER_CHARACTERS = 3_000;
const DOI = /\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/giu;
const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with",
]);

export type PaperIdentityStatus = "verified" | "inconclusive" | "mismatch";

export interface PaperIdentityExpectation {
  doi?: string | null;
  title?: string | null;
  authors?: string | null;
  year?: string | null;
}

export interface PaperIdentityVerification {
  status: PaperIdentityStatus;
  method: "doi" | "title_author_year" | "title_author" | "title_year" | "none";
  doiMatched: boolean | null;
  titleTokenCoverage: number | null;
  authorMatched: boolean | null;
  yearMatched: boolean | null;
  reason:
    | "expected_doi_found"
    | "different_front_matter_doi"
    | "title_and_metadata_match"
    | "text_extraction_unavailable"
    | "insufficient_identity_evidence";
}

function normalizedDoi(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi\s*:\s*/i, "")
    .replace(/[.,;:]+$/g, "")
    .toLowerCase();
  const match = normalized.match(/^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i);
  return match ? normalized : null;
}

function normalizedWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/-\s*\r?\n\s*/g, "")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function informativeTitleTokens(title: string): string[] {
  return normalizedWords(title).filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function containsContiguousSequence(needle: string[], haystack: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, index) => haystack[start + index] === token)) return true;
  }
  return false;
}

function compatibleTextTokens(words: string[], titleTokens: string[]): string[] {
  const expected = new Set(titleTokens);
  const compatible: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const joined = index + 1 < words.length ? `${words[index]}${words[index + 1]}` : "";
    if (joined && expected.has(joined)) {
      compatible.push(joined);
      index += 1;
      continue;
    }
    const token = words[index]!;
    if (token.length > 1 && !STOPWORDS.has(token)) compatible.push(token);
  }
  return compatible;
}

function tokenCoverage(needle: string[], haystack: Set<string>): number {
  if (needle.length === 0) return 0;
  return needle.filter((token) => haystack.has(token)).length / needle.length;
}

function labeledFrontMatterDois(text: string): Set<string> {
  const dois = new Set<string>();
  for (const match of text.matchAll(DOI)) {
    const index = match.index ?? 0;
    if (index >= PRIMARY_FRONT_MATTER_CHARACTERS) continue;
    const prefix = text.slice(Math.max(0, index - 40), index).toLowerCase();
    const before = text.slice(0, index).toLowerCase();
    const referenceHeading = before.lastIndexOf("references");
    const inReferences = referenceHeading >= 0 && index - referenceHeading < 5_000;
    const labeled = /(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/\s*)$/i.test(prefix);
    const doi = normalizedDoi(match[0]);
    if (labeled && !inReferences && doi) dois.add(doi);
  }
  return dois;
}

function primaryIdentityText(text: string): string {
  const primary = text.slice(0, PRIMARY_FRONT_MATTER_CHARACTERS);
  const references = primary.match(/(?:^|\r?\n)\s*references\s*(?:\r?\n|$)/i);
  return references?.index === undefined ? primary : primary.slice(0, references.index);
}

function firstAuthorFamilyName(authors: string | null | undefined): string | null {
  if (!authors) return null;
  const first = authors.split(/\s*(?:,|;|\band\b)\s*/i)[0] ?? "";
  const words = normalizedWords(first).filter((word) => word.length > 1);
  return words.at(-1) ?? null;
}

function yearMatches(expected: string | null | undefined, text: string): boolean | null {
  const parsed = expected?.match(/\b(19|20)\d{2}\b/)?.[0];
  if (!parsed) return null;
  const year = Number(parsed);
  return [year - 1, year, year + 1].some((candidate) => new RegExp(`\\b${candidate}\\b`).test(text));
}

export function verifyPaperIdentity(
  extractedText: string,
  expected: PaperIdentityExpectation,
): PaperIdentityVerification {
  const identityText = primaryIdentityText(extractedText);
  const expectedDoi = normalizedDoi(expected.doi);
  const labeledDois = labeledFrontMatterDois(identityText);
  const doiMatched = expectedDoi ? labeledDois.has(expectedDoi) : null;

  const titleTokens = expected.title ? informativeTitleTokens(expected.title) : [];
  const frontWords = normalizedWords(identityText);
  const frontTitleWords = compatibleTextTokens(frontWords, titleTokens);
  const coverage = titleTokens.length > 0 ? tokenCoverage(titleTokens, new Set(frontTitleWords)) : null;
  const author = firstAuthorFamilyName(expected.authors);
  const authorMatched = author ? frontWords.includes(author) : null;
  const yearMatched = yearMatches(expected.year, identityText);
  const titleStrong = containsContiguousSequence(titleTokens, frontTitleWords);
  const corroborators = Number(authorMatched === true) + Number(yearMatched === true);
  const enoughCorroboration = titleTokens.length < 5 ? corroborators === 2 : corroborators >= 1;

  if (expectedDoi && labeledDois.has(expectedDoi) && (titleTokens.length === 0 || titleStrong)) {
    return {
      status: "verified",
      method: "doi",
      doiMatched: true,
      titleTokenCoverage: coverage,
      authorMatched,
      yearMatched,
      reason: "expected_doi_found",
    };
  }

  if (titleStrong && enoughCorroboration) {
    return {
      status: "verified",
      method: authorMatched && yearMatched ? "title_author_year" : authorMatched ? "title_author" : "title_year",
      doiMatched,
      titleTokenCoverage: coverage,
      authorMatched,
      yearMatched,
      reason: "title_and_metadata_match",
    };
  }


  if (expectedDoi && [...labeledDois].some((doi) => doi !== expectedDoi)) {
    return {
      status: "mismatch",
      method: "doi",
      doiMatched: false,
      titleTokenCoverage: coverage,
      authorMatched,
      yearMatched,
      reason: "different_front_matter_doi",
    };
  }

  return {
    status: "inconclusive",
    method: "none",
    doiMatched,
    titleTokenCoverage: coverage,
    authorMatched,
    yearMatched,
    reason: "insufficient_identity_evidence",
  };
}
