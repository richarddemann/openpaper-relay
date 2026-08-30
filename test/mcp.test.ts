import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PaperStore } from "../src/store.js";
import { makePdf } from "./fixture.js";

test("MCP server advertises the narrow fetch, text, and PDF interfaces", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "paper-mcp-"));
  const configPath = join(temporary, "sites.json");
  await writeFile(
    configPath,
    JSON.stringify({
      sites: [
        {
          id: "test-site",
          label: "Test Site",
          startUrl: "https://library.example/",
          doiUrlTemplate: "https://resolver.example/?doi={doi}",
          allowedNetworkHosts: ["library.example", "resolver.example", "publisher.example"],
          allowedPaperUrlHosts: ["publisher.example"],
          allowedPdfHosts: ["publisher.example"],
        },
      ],
    }),
  );
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const state = join(temporary, "state");
  const stored = await new PaperStore(state, 30_000_000).put(makePdf("MCP resource fixture"), "fixture.pdf");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/mcp-server.js")],
    env: {
      ...environment,
      OPENPAPER_RELAY_CONFIG: configPath,
      OPENPAPER_RELAY_STATE_DIR: state,
    },
  });
  const client = new Client({ name: "openpaper-relay-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["download_open_paper", "fetch_authorized_paper", "fetch_best_open_paper", "read_paper_text", "search_open_papers"],
    );
    assert.equal(tools.tools.find((tool) => tool.name === "fetch_authorized_paper")?.annotations?.readOnlyHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === "search_open_papers")?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "download_open_paper")?.annotations?.readOnlyHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === "fetch_best_open_paper")?.annotations?.readOnlyHint, false);
    assert.equal(tools.tools.find((tool) => tool.name === "read_paper_text")?.annotations?.readOnlyHint, true);
    const templates = await client.listResourceTemplates();
    assert.deepEqual(templates.resourceTemplates.map((template) => template.uriTemplate), ["paper://{paper_id}"]);
    const textResult = await client.callTool({ name: "read_paper_text", arguments: { paper_id: stored.paperId } });
    assert.match(JSON.stringify(textResult.content), /MCP resource fixture/);
    const resource = await client.readResource({ uri: `paper://${stored.paperId}` });
    assert.equal(resource.contents[0]?.mimeType, "application/pdf");
    assert.equal("blob" in (resource.contents[0] ?? {}), true);
  } finally {
    await client.close();
  }
});
