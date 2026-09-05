# OpenPaper Relay

OpenPaper Relay is a local CLI and MCP server for retrieving research PDFs by DOI, PMID, PMCID, arXiv ID, or exact title. It checks each downloaded PDF against the requested paper and tries another source if the identity does not match.

Sources run in this order: Europe PMC, Unpaywall (when configured), arXiv, then OpenAlex. Institutional access requires a site adapter and a browser login. Anna’s Archive is not implemented.

A paper can exist in an index without having a downloadable PDF; a failed lookup does not establish that no copy is available elsewhere.

## Quick start

You need Node.js 22 or newer.

```bash
git clone https://github.com/richarddemann/openpaper-relay.git
cd openpaper-relay
npm ci
npm run build
```

Fetch a paper by DOI or arXiv ID:

```bash
npm run fetch-best -- "10.1371/journal.ppat.1002485"
npm run fetch-best -- "1706.03762"
```

Europe PMC, arXiv, and basic OpenAlex lookups work without configuration. To enable Unpaywall, create an ignored `sites.local.json` containing `{"unpaywallEmail":"you@example.edu","sites":[]}`.

OpenAlex uses publisher and repository PDF links. To raise its metadata API allowance, add an optional `"openalexApiKey":"YOUR_KEY"` to `sites.local.json`; free keys are available from [OpenAlex](https://openalex.org/settings/api). The adapter does not use the paid content-download endpoint.

You can also paste a `https://doi.org/...` URL or a `doi:...` identifier. For a title search, review the matches before downloading:

```bash
npm run search-open -- "Exact paper title"
npm run download-open -- "<version_id>"
```

## If retrieval fails

Check the returned `attempts` for each source’s search or download error. `not_found` means no matching candidate was found; `exhausted` means a match was found but its PDF versions could not be retrieved. `selection_required` needs a choice from the returned candidates. A downloaded copy marked `inconclusive` still needs an identity check.

## Use it with an agent

After building, add this local command to your MCP client, using the absolute paths on your computer:

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

## Local storage and network requests

There is no hosted service or telemetry. PDFs, settings, and browser sessions are stored on the computer running the server.

Default state lives outside the repository, and `sites.local.json` is ignored; keep any custom state directory out of version control. The requested paper identifier may be sent to the built-in Europe PMC, arXiv, and OpenAlex sources and, when enabled, Unpaywall or a configured institutional site.

Use the MCP server locally. Do not expose it as a public network service.

## Add an institutional source

Institutional access is optional. A user can configure their own resolver or library site, complete its normal login and MFA themselves, and let the local adapter reuse that session. Credentials and cookies are not returned to the agent.

See [ADAPTING.md](ADAPTING.md) for the setup guide. See [ADDING_SOURCES.md](ADDING_SOURCES.md) to add another open repository or metadata service.

## Development

Run `npm test` to build and run the fixture tests, including MCP integration. These tests do not contact live paper providers. Use the quick-start fetch commands to check live retrieval.

Security issues can be reported as described in [SECURITY.md](SECURITY.md).

MIT licensed. See [LICENSE](LICENSE).
