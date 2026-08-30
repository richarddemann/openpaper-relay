import { lookup } from "node:dns/promises";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Download, type Page, type Response } from "playwright";
import {
  assertAllowedDownloadUrl,
  assertAllowedRequestUrl,
  assertAllowedUrl,
  filenameFromContentDisposition,
  ipIsPublic,
  normalizeIdentifier,
  safeFilename,
} from "./security.js";
import { assertDeclaredPdfLength, readPdfFileWithinLimit, validatePdf } from "./pdf.js";
import type { SiteConfig } from "./types.js";

export type BrowserFetchOutcome =
  | { status: "downloaded"; data: Buffer; filename: string }
  | { status: "login_required" }
  | { status: "not_found" };

interface CapturedPdf {
  data: Buffer;
  filename: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export class AuthorizedBrowser {
  constructor(
    private readonly profilesRoot: string,
    private readonly maxPdfBytes: number,
  ) {}

  async login(site: SiteConfig): Promise<BrowserContext> {
    const context = await this.launch(site, true);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(site.startUrl, { waitUntil: "domcontentloaded", timeout: site.navigationTimeoutMs });
    return context;
  }

  async fetch(site: SiteConfig, identifier: string): Promise<BrowserFetchOutcome> {
    const identifierTarget = normalizeIdentifier(identifier, site.doiUrlTemplate);
    const inputHosts = identifierTarget.kind === "doi" ? site.allowedNetworkHosts : site.allowedPaperUrlHosts;
    const target = await assertAllowedUrl(identifierTarget.url, inputHosts);
    const context = await this.launch(site, false);
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const direct = await this.captureAround(page, site, async () => {
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: site.navigationTimeoutMs });
      });
      if (direct) return { status: "downloaded", ...direct };
      await delay(site.waitAfterNavigationMs);
      if (await this.isLoginPage(page, site)) return { status: "login_required" };

      for (const selector of site.pdfLinkSelectors) {
        const locator = page.locator(selector).first();
        if ((await locator.count()) === 0) continue;
        const href = await locator.getAttribute("href");
        if (!href) continue;
        const pdfUrl = new URL(href, page.url());
        await assertAllowedUrl(pdfUrl, site.allowedNetworkHosts);
        const captured = await this.captureAround(page, site, async () => {
          await page.goto(pdfUrl.href, { waitUntil: "domcontentloaded", timeout: site.navigationTimeoutMs });
        });
        if (captured) return { status: "downloaded", ...captured };
      }

      for (const selector of site.pdfClickSelectors) {
        const locator = page.locator(selector).first();
        if ((await locator.count()) === 0 || !(await locator.isVisible())) continue;
        const captured = await this.captureAround(page, site, async () => {
          await locator.click({ timeout: site.navigationTimeoutMs });
        });
        if (captured) return { status: "downloaded", ...captured };
      }

      if (await this.isLoginPage(page, site)) return { status: "login_required" };
      return { status: "not_found" };
    } finally {
      await context.close();
    }
  }

  private async launch(site: SiteConfig, headed: boolean): Promise<BrowserContext> {
    const profilePath = resolve(this.profilesRoot, site.id);
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await chmod(this.profilesRoot, 0o700);
    await chmod(profilePath, 0o700);
    const resolverRules = await this.resolverRules(site.allowedNetworkHosts);
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: !headed,
      acceptDownloads: true,
      serviceWorkers: "block",
      args: [`--host-resolver-rules=${resolverRules}`],
    });
    context.setDefaultTimeout(site.navigationTimeoutMs);
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (["data:", "blob:", "about:", "chrome-extension:"].includes(requestUrl.protocol)) {
        await route.continue();
        return;
      }
      try {
        assertAllowedRequestUrl(requestUrl, site.allowedNetworkHosts);
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket("**/*", (webSocket) => {
      webSocket.close({ code: 1008, reason: "WebSocket connections are disabled by OpenPaper Relay policy" });
    });
    return context;
  }

  private async resolverRules(hosts: readonly string[]): Promise<string> {
    const mappings: string[] = [];
    for (const host of hosts) {
      const addresses = await lookup(host, { all: true, verbatim: true });
      const address = addresses.find((candidate) => candidate.family === 4 && ipIsPublic(candidate.address)) ??
        addresses.find((candidate) => ipIsPublic(candidate.address));
      if (!address) throw new Error(`allowlisted host has no public IP address: ${host}`);
      mappings.push(`MAP ${host} ${address.address}`);
    }
    mappings.push("EXCLUDE localhost");
    return mappings.join(",");
  }

  private async isLoginPage(page: Page, site: SiteConfig): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (site.loginUrlPatterns.some((pattern) => url.includes(pattern.toLowerCase()))) return true;
    for (const selector of site.loginPageSelectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible())) return true;
    }
    return false;
  }

  private async captureAround(page: Page, site: SiteConfig, action: () => Promise<void>): Promise<CapturedPdf | null> {
    const captureTimeout = Math.min(12_000, site.navigationTimeoutMs);
    const responsePromise = page
      .waitForResponse(
        (response) => response.headers()["content-type"]?.toLowerCase().includes("application/pdf") === true,
        { timeout: captureTimeout },
      )
      .then((response) => this.readPdfResponse(response, site));
    const downloadPromise = page
      .waitForEvent("download", { timeout: captureTimeout })
      .then((download) => this.readDownload(download, site));

    let actionError: unknown;
    try {
      await action();
    } catch (error) {
      actionError = error;
    }

    try {
      return await Promise.any([responsePromise, downloadPromise]);
    } catch {
      if (actionError) throw actionError;
      return null;
    }
  }

  private async readPdfResponse(response: Response, site: SiteConfig): Promise<CapturedPdf> {
    await assertAllowedUrl(response.url(), site.allowedPdfHosts);
    assertDeclaredPdfLength(response.headers()["content-length"], this.maxPdfBytes);
    const data = await response.body();
    validatePdf(data, this.maxPdfBytes);
    return {
      data,
      filename: safeFilename(filenameFromContentDisposition(response.headers()["content-disposition"])),
    };
  }

  private async readDownload(download: Download, site: SiteConfig): Promise<CapturedPdf> {
    await assertAllowedDownloadUrl(download.url(), site.allowedPdfHosts);
    const path = await download.path();
    if (!path) throw new Error("browser download did not produce a local file");
    const data = await readPdfFileWithinLimit(path, this.maxPdfBytes);
    validatePdf(data, this.maxPdfBytes);
    return { data, filename: safeFilename(download.suggestedFilename()) };
  }
}
