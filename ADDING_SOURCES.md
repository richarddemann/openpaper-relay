# Add a paper source

The Europe PMC, Unpaywall, arXiv, and OpenAlex implementations are references for sources that accept a DOI, identifier, or title; return metadata and available PDF versions; and download one selected version. `OpenPaperResolver` runs them in array order and stops at the first identity-verified download for an exact identifier.

Metadata accuracy matters: DOI is the strongest identity signal, while title matches require author or year corroboration. If your source omits those fields, downloads may correctly be labeled `inconclusive` for manual review.

Use a documented API that permits automated retrieval. Keep authentication interactive when required.

## The two public operations

Implement these behaviors in a new module under `src/`:

1. `search(query)` returns normalized candidates. Each candidate contains bibliographic metadata and zero or more opaque version IDs.
2. `download(versionId)` validates the opaque ID, queries the source again, selects that current version, and downloads it.

Copy the shape used by `src/europe-pmc.ts`:

```ts
interface SourceClient {
  readonly sourceName: string;
  accepts(versionId: string): boolean;
  search(query: string): Promise<OpenPaperSearchResult>;
  download(versionId: string): Promise<DownloadedOpenPdf>;
}
```

## Validate identifiers and downloads

- Fix the API origin in the adapter. For repository links returned by an API, use `SecurePdfDownloader`, which validates public IP addresses and pins DNS for each request and redirect. Fixed-host providers can restrict PDF origins further.
- Require HTTPS, standard port 443, and expected download paths.
- Follow redirects manually and validate every destination.
- Bound metadata responses separately from PDFs.
- Require a PDF content type, configured byte limit, PDF signature, and end marker.
- Never put a PDF URL inside `versionId` and never accept a URL in the download operation.
- Re-query the source during download so a caller cannot forge or reuse a stale location.
- Return metadata and provenance with the stored content-hash paper ID.

A version ID can contain a source-owned identifier and a digest of the selected source URL:

```text
SOURCE12345:pdf:<sha256-of-source-url>
```

The downloader parses that restricted format, looks up `SOURCE12345` again, and selects the fresh response whose URL has the same digest. If the source removes or changes that version, download fails rather than silently selecting a different file.

Hostnames and landing-page URLs returned by a tool are visible to its client, even if the adapter source is private.

## Wire it into the fallback chain

Add the client to the source array in `PaperFetcherService`. Its position is its priority:

```ts
this.openPapers = new OpenPaperResolver([
  new EuropePmcClient(config.maxPdfBytes),
  new YourSourceClient(config.maxPdfBytes),
  new ArxivClient(config.maxPdfBytes),
]);
```

The existing `fetch_best_open_paper`, `search_open_papers`, and `download_open_paper` tools then use it automatically; a new public tool is normally unnecessary. Search is read-only. Fetch and download remain non-read-only and non-idempotent because they consume network and local storage resources.

Keep download inputs restricted to source-owned version IDs.

## Test before enabling it

At the public client seam, test:

1. DOI and title queries normalize metadata correctly.
2. Only explicitly downloadable versions receive IDs.
3. A forged URL or malformed version ID is rejected before networking.
4. Download re-resolves the selected version.
5. Redirects respect the provider’s host restrictions; repository downloads reject private-network destinations.
6. Oversized, HTML, truncated, and malformed PDF responses are rejected.
7. The MCP tool list exposes only the intended narrow fetch, search, download, text, and PDF-resource operations.

Use fixtures for routine tests. Run one real search and one permitted download against the source's official production API before considering the adapter complete.
