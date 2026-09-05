# OpenPaper Relay

Download research papers from the command line or an MCP client. Accepts a DOI, PMID, PMCID, arXiv ID, or title and checks the PDF against the paper’s metadata.

Tries Europe PMC, Unpaywall, arXiv, and OpenAlex in that order. Unpaywall needs an email address; the other sources work without configuration.

## Install

Requires Node.js 22 or later.

```sh
git clone https://github.com/richarddemann/openpaper-relay.git
cd openpaper-relay
npm ci
npm run build
```

## Usage

```sh
npm run fetch-best -- "10.1371/journal.ppat.1002485"
npm run fetch-best -- "https://doi.org/10.1371/journal.ppat.1002485"
npm run fetch-best -- "1706.03762"
```

To choose a copy from search results:

```sh
npm run search-open -- "Attention Is All You Need"
npm run download-open -- "<version_id>"
```

Commands return JSON. Downloads include a `paperId` and verification result. If verification is `inconclusive`, check the copy before using it. Failed requests include an `attempts` list with the errors from each source.

PDFs and browser sessions are saved under `~/.local/share/openpaper-relay/`. Set `OPENPAPER_RELAY_STATE_DIR` to use another directory.

## Configuration

Optional settings go in `sites.local.json`, which Git ignores:

```json
{
  "unpaywallEmail": "you@example.edu",
  "sites": []
}
```

OpenAlex downloads come from the publisher or repository links in its metadata. You can add `"openalexApiKey": "YOUR_KEY"` for a higher API allowance. Get a free key from [OpenAlex](https://openalex.org/settings/api).

For institutional access, see [Add an institutional site](ADAPTING.md). Login happens in a local browser.

## MCP

Add this server command to your MCP client, replacing the paths:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/openpaper-relay/dist/mcp-server.js"],
  "env": {
    "OPENPAPER_RELAY_CONFIG": "/absolute/path/to/openpaper-relay/sites.local.json",
    "OPENPAPER_RELAY_STATE_DIR": "/absolute/path/to/paper-storage"
  }
}
```

Run the server locally; it has no network authentication.

## Agent skill

The [skill](skills/openpaper-relay/SKILL.md) tells an agent how to retrieve a paper, handle ambiguous matches, and read the downloaded PDF. It checks Zotero or specified PDF folders first when available.

For Codex, copy the skill from this checkout:

```sh
mkdir -p ~/.codex/skills
cp -R skills/openpaper-relay ~/.codex/skills/
```

Then ask: `Use $openpaper-relay to get the paper 10.1371/journal.ppat.1002485.`

Connect the MCP server above as well; the skill contains instructions, not the downloader. For another agent that supports `SKILL.md`, install the same folder in its skill directory.

## Development

`npm test` builds the project and runs the tests with fixtures. The commands above can be used to check live retrieval.

[Adding a source](ADDING_SOURCES.md) · [Security reports](SECURITY.md) · [MIT license](LICENSE)
