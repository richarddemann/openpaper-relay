# OpenPaper Relay

OpenPaper Relay is a local MCP server and command-line tool for retrieving one requested research paper. Give it a DOI, PMID, PMCID, arXiv ID, or exact title; it tries a short list of lawful sources in order and saves the first usable PDF.

The current source chain is:

1. Europe PMC
2. Unpaywall, when a contact email is configured
3. arXiv
4. an optional institutional browser adapter, for DOI requests only

Fetch-best results include an attempt log and an identity result. `verified` means the PDF's front matter matched the expected DOI or a strong title/author/year combination. `inconclusive` means there was not enough text to decide. A clear mismatch is discarded and the next source is tried. This is a practical check, not a cryptographic guarantee.

## Install

OpenPaper Relay currently runs from source and requires Node.js 22 or newer.

```bash
npm ci
npm test
```

Europe PMC and arXiv need no configuration:

```bash
npm run fetch-best -- "10.1371/journal.ppat.1002485"
npm run fetch-best -- "1706.03762"
```

To add Unpaywall, create an ignored `sites.local.json` with your contact email:

```json
{
  "unpaywallEmail": "you@example.edu",
  "sites": []
}
```

For an ambiguous title, search first and choose one of the returned versions:

```bash
npm run search-open -- "Exact paper title"
npm run download-open -- "<version_id>"
```

A successful fetch looks roughly like this:

```json
{
  "status": "downloaded",
  "paperId": "<content-derived id>",
  "resourceUri": "paper://<content-derived id>",
  "verification": {
    "status": "verified",
    "reason": "expected_doi_found"
  }
}
```

Other normal results include `selection_required`, `exhausted`, `login_required`, and a downloaded PDF with `verification.status` set to `inconclusive`.

By default, papers and metadata are stored under `~/.local/share/openpaper-relay`. Set `OPENPAPER_RELAY_STATE_DIR` to use another private directory.

## MCP setup

Build the server:

```bash
npm run build
```

Then add it to an MCP client as a local stdio server. Use absolute paths:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/openpaper-relay/dist/mcp-server.js"],
  "env": {
    "OPENPAPER_RELAY_CONFIG": "/absolute/path/to/openpaper-relay/sites.local.json",
    "OPENPAPER_RELAY_STATE_DIR": "/absolute/path/to/private/openpaper-state"
  }
}
```

The useful tools are `fetch_best_open_paper`, `search_open_papers`, `download_open_paper`, `read_paper_text`, and the advanced `fetch_authorized_paper`.

This server is designed for local stdio use. It has no user authentication or tenant isolation, so do not expose it through an unauthenticated HTTP, WebSocket, or TCP wrapper.

## Agent skill and Zotero

The repository includes an [agent skill](skills/openpaper-relay/SKILL.md). It tells an agent to check Zotero or explicitly listed PDF folders before fetching another copy, and to stop on ambiguous or inconclusive results instead of guessing.

Zotero is not built into this server. The agent needs a separate Zotero-capable tool, and Zotero Desktop needs to be available to that tool. To install the skill in Codex:

```bash
cp -R skills/openpaper-relay ~/.codex/skills/
```

Edit the small configuration block in the installed skill if you want to add local PDF directories or a configured institutional site.

## Institutional adapters

Institutional access is optional and intended for people comfortable maintaining a small browser adapter. The checked-in `sites.example.json` is deliberately nonfunctional; every example hostname and selector must be replaced.

The short version:

1. Copy `sites.example.json` to the ignored `sites.local.json`.
2. Add only the exact hosts used by your resolver, login flow, article pages, and PDF downloads.
3. Add selectors for the site's PDF link or download button.
4. Install the browser with `npx playwright install chromium`.
5. Run `npm run login -- "your-university"` and complete the normal login and MFA yourself.
6. Check the loaded site IDs with `npm run sites`.
7. Test one DOI with `npm run fetch -- "10.xxxx/example" "your-university"`.

The adapter reuses its own local browser profile. It does not automate passwords, MFA, or CAPTCHAs, and it does not return cookies or download URLs to the agent. An allowlisted URL can also be fetched directly, but without a DOI or other expected metadata its identity result will be `inconclusive`.

Read [ADAPTING.md](ADAPTING.md) before adding a site. The host list is a security boundary: keep it narrow and review changes like code.

## Security notes

- Open-source PDF downloads use HTTPS, public-IP DNS checks, redirect validation, and a streaming byte limit.
- Browser adapters allow only configured HTTPS hosts and block WebSockets and service workers. Inline PDF responses require a valid declared size; completed browser downloads are size-checked before Node reads them. Chromium may still create its own temporary download before that check, so configured PDF hosts must be trusted.
- Stored paper IDs are content hashes; callers cannot supply filesystem paths or arbitrary download URLs.
- State directories and files are created with owner-only permissions. Put a custom state directory somewhere controlled by your OS account, not in a shared writable folder.
- PDF text extraction runs in a separate, time- and memory-limited process. It is isolation, not a full operating-system sandbox.
- Titles, metadata, and PDF text are untrusted content. The bundled MCP instructions and skill tell agents never to follow instructions found inside a paper.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Scope

This is not a scholarly search engine, a Zotero replacement, a paywall bypass, or a bulk downloader. It will not find every paper. Its job is narrower: give a local agent a controlled way to try a few configured sources for one paper without granting arbitrary network or filesystem access.

Coverage is intentionally small. See [ADDING_SOURCES.md](ADDING_SOURCES.md) if you want to add another open repository or lawful metadata service.

MIT licensed. See [LICENSE](LICENSE).
