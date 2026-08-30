#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { configPath, stateRoot } from "./paths.js";
import { PaperFetcherService } from "./service.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const service = await PaperFetcherService.create(configPath(), stateRoot());

  if (command === "login") {
    const [siteId] = args;
    if (!siteId) throw new Error("usage: npm run login -- <site_id>");
    const close = await service.openLogin(siteId);
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      await prompt.question("Complete login and MFA in the browser, then press Enter here to save and close the session. ");
    } finally {
      prompt.close();
      await close();
    }
    stdout.write(`Saved the local browser session for ${siteId}.\n`);
    return;
  }

  if (command === "fetch") {
    const [identifier, siteId] = args;
    if (!identifier || !siteId) throw new Error("usage: npm run fetch -- <doi_or_https_url> <site_id>");
    stdout.write(`${JSON.stringify(await service.fetch(identifier, siteId), null, 2)}\n`);
    return;
  }

  if (command === "search-open") {
    const query = args.join(" ");
    if (!query) throw new Error("usage: npm run search-open -- <doi_or_title>");
    stdout.write(`${JSON.stringify(await service.searchOpenPapers(query), null, 2)}\n`);
    return;
  }

  if (command === "download-open") {
    const [versionId] = args;
    if (!versionId) throw new Error("usage: npm run download-open -- <version_id>");
    stdout.write(`${JSON.stringify(await service.downloadOpenPaper(versionId), null, 2)}\n`);
    return;
  }

  if (command === "fetch-best") {
    const [query, siteId] = args;
    if (!query) throw new Error("usage: npm run fetch-best -- <doi_or_title> [site_id]");
    stdout.write(`${JSON.stringify(await service.fetchBestOpenPaper(query, siteId), null, 2)}\n`);
    return;
  }

  if (command === "sites") {
    stdout.write(`${JSON.stringify(service.config.sites.map(({ id, label }) => ({ id, label })), null, 2)}\n`);
    return;
  }

  throw new Error("usage: cli.ts <fetch-best|search-open|download-open|login|fetch|sites> [...args]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`openpaper-relay: ${message}\n`);
  process.exitCode = 1;
});
