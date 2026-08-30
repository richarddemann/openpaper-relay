#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configPath, stateRoot } from "./paths.js";
import { PaperFetcherService } from "./service.js";

const instructions =
  "For one DOI, PMID, PMCID, arXiv ID, or exact title, use fetch_best_open_paper first. It tries configured legal sources in order, stops at the first verified PDF, and reports each failed attempt. If it returns selection_required, present the candidates and use download_open_paper only with the user's selected version_id. Pass site_id only when the user wants their configured institutional access tried after open sources fail. Never use these tools for bulk retrieval, credentials, MFA, CAPTCHA bypass, or access-control circumvention. If institutional fetching returns login_required, ask the user to reauthenticate locally. After download, use read_paper_text for analysis; read paper:// resources only when layout or figures matter.";

async function main(): Promise<void> {
  const service = await PaperFetcherService.create(configPath(), stateRoot());
  const server = new McpServer(
    { name: "openpaper-relay", version: "1.2.0" },
    { instructions },
  );

  server.registerTool(
    "search_open_papers",
    {
      title: "Search legal open-paper sources",
      description:
        "Search Europe PMC, optional Unpaywall, and arXiv by DOI, PMCID, PMID, arXiv ID, or title. Returns merged metadata and the PDF versions each source reports as openly available.",
      inputSchema: {
        query: z.string().min(3).max(500).describe("DOI, PMCID, PMID, arXiv ID, or paper title"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      const result = await service.searchOpenPapers(query);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { query: result.query, candidates: result.candidates },
      };
    },
  );

  server.registerTool(
    "fetch_best_open_paper",
    {
      title: "Fetch the first available legal PDF",
      description:
        "Try configured legal sources sequentially and stop after the first verified PDF. Returns an attempt log when sources fail. Ambiguous title results require user selection. An optional site_id enables the user's configured institutional source as the final DOI fallback.",
      inputSchema: {
        query: z.string().min(3).max(500).describe("DOI, PMCID, PMID, arXiv ID, or exact paper title"),
        site_id: z.string().min(2).max(64).optional().describe("Optional configured institutional adapter ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, site_id }) => {
      const result = await service.fetchBestOpenPaper(query, site_id);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "download_open_paper",
    {
      title: "Download one selected open-access PDF",
      description:
        "Download exactly one open-access PDF using an opaque version_id previously returned by search_open_papers. Arbitrary URLs are not accepted.",
      inputSchema: {
        version_id: z
          .string()
          .min(10)
          .max(500)
          .describe("Opaque version ID returned by search_open_papers"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ version_id }) => {
      const result = await service.downloadOpenPaper(version_id);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "fetch_authorized_paper",
    {
      title: "Fetch one authorized academic paper",
      description:
        "Use this when a user requested one paper, normal legal/open-access retrieval failed, and a DOI or allowlisted publisher URL is available. Uses the user's saved institutional browser session. Never use for bulk retrieval or to bypass authentication, CAPTCHA, MFA, paywalls, or access restrictions.",
      inputSchema: {
        identifier: z.string().min(3).describe("A DOI such as 10.1038/example or an absolute allowlisted HTTPS URL"),
        site_id: z.string().min(2).describe("Configured institutional site adapter ID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ identifier, site_id }) => {
      const result = await service.fetch(identifier, site_id);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: result.status !== "downloaded",
      };
    },
  );

  server.registerTool(
    "read_paper_text",
    {
      title: "Read text from a fetched paper",
      description:
        "Use this after fetch_authorized_paper returns downloaded. Extracts bounded text from the opaque paper_id without exposing local paths or accepting arbitrary files.",
      inputSchema: {
        paper_id: z.string().regex(/^[a-f0-9]{64}$/).describe("Opaque paper ID returned by fetch_authorized_paper"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ paper_id }) => {
      const result = await service.extractText(paper_id);
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: { paperId: paper_id, pages: result.pages, text: result.text },
      };
    },
  );

  server.registerResource(
    "fetched-paper-pdf",
    new ResourceTemplate("paper://{paper_id}", { list: undefined }),
    {
      title: "Fetched paper PDF",
      description: "A PDF fetched by this server, addressed only by its content-derived opaque ID.",
      mimeType: "application/pdf",
    },
    async (uri, variables) => {
      const paperId = String(variables.paper_id);
      const paper = await service.readPdf(paperId);
      return {
        contents: [
          {
            uri: uri.href,
            name: paper.filename,
            mimeType: "application/pdf",
            blob: paper.data.toString("base64"),
          },
        ],
      };
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`openpaper-relay failed: ${message}\n`);
  process.exitCode = 1;
});
