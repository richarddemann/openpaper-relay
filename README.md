# OpenPaper Relay

OpenPaper Relay is a local MCP server that turns a DOI, PMID, PMCID, arXiv ID, or exact title into an identity-checked PDF without giving an agent a generic downloader.

It solves a common research-agent failure: the citation is known, but the PDF is not immediately accessible. The agent can check a local library first, then relay the request through narrowly configured sources until one succeeds.

```text
Zotero / local PDFs
        ↓ not found
Europe PMC → Unpaywall → arXiv
        ↓ still unavailable, optional
Your authorized institutional browser session
```

The relay checks each downloaded PDF against the expected DOI or title, author, and year. It discards a clear mismatch and tries the next source. A scanned or text-poor copy is labeled `inconclusive` for agent or user review instead of being called verified. It does not automate credentials or MFA, bypass CAPTCHAs or paywalls, use unauthorized mirrors, or support bulk downloading.

## Quick start

Requirements: Node.js 22+, macOS or Linux.

```bash
npm install
npm run check
npm test
```

Europe PMC and arXiv work without configuration. To enable Unpaywall, copy the example and replace its contact-email placeholder:

```bash
cp sites.example.json sites.local.json
npm run fetch-best -- "10.1371/journal.ppat.1002485"
npm run fetch-best -- "1706.03762"
```

An ambiguous title returns `selection_required` instead of guessing:

```bash
npm run search-open -- "Exact paper title"
npm run download-open -- "<returned version_id>"
```

## Give it to an agent

The bundled [`openpaper-relay` skill](skills/openpaper-relay/SKILL.md) tells an agent to:

1. check Zotero when a Zotero tool or plugin is available;
2. check only explicitly configured local PDF folders;
3. call `fetch_best_open_paper` if no local attachment exists;
4. confirm any identity result labeled `inconclusive` before using the paper;
5. surface ambiguity, login requirements, and exhausted sources without bypassing controls.

The Zotero integration is optional. It uses Zotero's local API through the agent's Zotero tool; OpenPaper Relay does not read or modify Zotero's database.
Local-library lookup belongs to the agent skill, not the MCP server: Zotero needs a separate Zotero-capable tool, and PDF folders must be explicitly listed in the installed skill and accessible to that agent.

For Codex, install the skill by copying its folder into your skills directory, then edit its small configuration block if you want local folders or automatic institutional fallback:

```bash
cp -R skills/openpaper-relay ~/.codex/skills/
```

## MCP interface

Build and run the stdio server:

```bash
npm run build
npm run serve
```

Configure an MCP client with absolute paths:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/openpaper-relay/dist/mcp-server.js"],
  "env": {
    "OPENPAPER_RELAY_CONFIG": "/absolute/path/to/openpaper-relay/sites.local.json",
    "OPENPAPER_RELAY_STATE_DIR": "/absolute/private/state/directory"
  }
}
```

Main tools:

- `fetch_best_open_paper({ query, site_id? })` — sequential fallback, identity checks, and an attempt log.
- `search_open_papers({ query })` — metadata and selectable open versions.
- `download_open_paper({ version_id })` — one version returned by search.
- `fetch_authorized_paper({ identifier, site_id })` — one paper through a configured institutional session.
- `read_paper_text({ paper_id })` and `paper://{paper_id}` — bounded text or the stored PDF.

## Add your university or another source

For a university page where an authorized user enters a DOI and downloads a PDF:

1. copy `sites.example.json` to the ignored `sites.local.json`;
2. replace every `example.edu`/`example.com` URL and hostname—the example site will not work unchanged;
3. add the exact resolver, login, publisher, and PDF hostnames;
4. add the selectors for the site's PDF link or button;
5. install the browser once with `npx playwright install chromium`;
6. run `npm run login -- <site_id>` and complete the normal login/MFA yourself;
7. pass that `site_id` for a DOI query only when institutional fallback is wanted.

In the bundled skill, set `institutional_fallback: auto` if a configured site should be accepted as the last fallback without asking on every paper.

The adapter is trusted configuration, not agent-generated browsing logic. The agent calls the narrow tool and never receives cookies, credentials, signed URLs, or arbitrary filesystem access. See [ADAPTING.md](ADAPTING.md) for the browser-adapter walkthrough and [ADDING_SOURCES.md](ADDING_SOURCES.md) for adding a lawful API/repository source.

## Security

- PDFs, metadata, and browser profiles remain in a private local state directory.
- URLs require HTTPS and exact host policies; private/reserved IPs and unsafe redirects are rejected.
- Repository downloads are DNS-checked and pinned to a public address.
- Responses are size-bounded and must pass PDF content, signature, and end-marker validation.
- Downloaded text is checked against expected DOI or title/author/year evidence before the PDF is accepted as verified; clear mismatches are discarded.
- Identity-checking uses a private temporary file that is removed immediately and never persists extracted verification text.
- Opaque version and paper IDs are used instead of caller-provided download URLs or file paths.
- Persistent per-source search/download limits and cross-process locks prevent uncontrolled retries.

Publisher, repository, and institutional terms still apply. Retrieve only papers the user requested and is authorized to access.

License: [MIT](LICENSE).
