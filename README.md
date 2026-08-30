# OpenPaper Relay

OpenPaper Relay helps an AI agent retrieve a research paper when the PDF is not already available locally. Give it a DOI, PMID, PMCID, arXiv ID, or exact title. It tries several legitimate sources in order and stops when it finds a usable match.

It currently supports Europe PMC, Unpaywall, arXiv, and optional institutional access configured by the user.

## Quick start

You need Node.js 22 or newer.

```bash
npm ci
npm test
```

Fetch a paper by DOI or arXiv ID:

```bash
npm run fetch-best -- "10.1371/journal.ppat.1002485"
npm run fetch-best -- "1706.03762"
```

Europe PMC and arXiv work without configuration. To enable Unpaywall, create an ignored `sites.local.json` containing `{"unpaywallEmail":"you@example.edu","sites":[]}`.

For a title search, review the matches before downloading:

```bash
npm run search-open -- "Exact paper title"
npm run download-open -- "<version_id>"
```

OpenPaper Relay checks the downloaded PDF against the expected DOI or paper details. Clear mismatches are discarded; uncertain matches are marked `inconclusive` for review.

## Use it with an agent

Build the local MCP server:

```bash
npm run build
```

Then add it to your MCP client as a local command, using the absolute path on your computer:

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

The included [agent skill](skills/openpaper-relay/SKILL.md) tells an agent to check Zotero or chosen PDF folders first, use OpenPaper Relay only when needed, and stop rather than guess when a result is ambiguous.

To install the skill in Codex, copy the `skills/openpaper-relay` folder into `~/.codex/skills/`.

## Your files stay yours

OpenPaper Relay runs on the user's own computer. It has no hosted service, telemetry, or connection to the maintainer's machine. The published repository contains none of the maintainer's PDFs, accounts, browser session, or local configuration.

Each installation keeps its PDFs, settings, and optional institutional browser session locally. Default state lives outside the repository, and `sites.local.json` is ignored; keep any custom state directory out of version control. The requested paper identifier may be sent to the built-in Europe PMC and arXiv sources and, when enabled, Unpaywall or a configured institutional site.

Use the MCP server locally. Do not expose it as a public network service.

## Add an institutional source

Institutional access is optional. A user can configure their own resolver or library site, complete its normal login and MFA themselves, and let the local adapter reuse that session. Credentials and cookies are not returned to the agent.

See [ADAPTING.md](ADAPTING.md) for the setup guide. See [ADDING_SOURCES.md](ADDING_SOURCES.md) to add another open repository or lawful metadata service.

## Scope

OpenPaper Relay fetches one requested paper at a time. It is not a scholarly search engine, a paywall bypass, or a bulk downloader.

Security issues can be reported as described in [SECURITY.md](SECURITY.md).

MIT licensed. See [LICENSE](LICENSE).
