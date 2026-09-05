import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { AppConfig, SiteConfig } from "./types.js";

const hostname = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase().replace(/\.$/, ""))
  .refine((value) => !value.includes(":") && !value.includes("/") && !value.includes("*") && isIP(value) === 0, {
    message: "host policy entries must be exact DNS hostnames, not wildcards, IPs, URLs, or host:port values",
  });

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443");
  }, {
    message: "institutional and resolver URLs must use HTTPS without credentials or nonstandard ports",
  });

const siteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    label: z.string().min(1).max(120),
    startUrl: httpsUrl,
    doiUrlTemplate: httpsUrl.refine((value) => value.includes("{doi}"), {
      message: "doiUrlTemplate must contain {doi}",
    }),
    allowedNetworkHosts: z.array(hostname).min(1),
    allowedPaperUrlHosts: z.array(hostname).min(1),
    allowedPdfHosts: z.array(hostname).min(1),
    loginUrlPatterns: z.array(z.string().min(1)).default([]),
    loginPageSelectors: z.array(z.string().min(1)).default(["input[type=password]"]),
    pdfLinkSelectors: z
      .array(z.string().min(1))
      .default(["a[href$='.pdf']", "a:has-text('PDF')", "a:has-text('Download PDF')"]),
    pdfClickSelectors: z
      .array(z.string().min(1))
      .default(["button:has-text('PDF')", "button:has-text('Download PDF')"]),
    waitAfterNavigationMs: z.number().int().min(0).max(30_000).default(1_500),
    navigationTimeoutMs: z.number().int().min(5_000).max(120_000).default(45_000),
  })
  .strict()
  .superRefine((site, context) => {
    for (const field of ["startUrl", "doiUrlTemplate"] as const) {
      const host = new URL(site[field].replace("{doi}", "10.0000/example")).hostname;
      if (!site.allowedNetworkHosts.includes(host)) {
        context.addIssue({
          code: "custom",
          path: ["allowedNetworkHosts"],
          message: `${field} host ${host} must be explicitly allowlisted`,
        });
      }
    }
    for (const [field, hosts] of [
      ["allowedPaperUrlHosts", site.allowedPaperUrlHosts],
      ["allowedPdfHosts", site.allowedPdfHosts],
    ] as const) {
      hosts.forEach((host, index) => {
        if (!site.allowedNetworkHosts.includes(host)) {
          context.addIssue({
            code: "custom",
            path: [field, index],
            message: `${host} must also appear in allowedNetworkHosts`,
          });
        }
      });
    }
  });

const appSchema = z
  .object({
    maxPdfBytes: z.number().int().min(100_000).max(100_000_000).default(30_000_000),
    maxDownloadsPerHour: z.number().int().min(1).max(100).default(12),
    maxSearchesPerHour: z.number().int().min(1).max(1_000).default(120),
    extractionTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    extractionMaxOldSpaceMb: z.number().int().min(64).max(1024).default(256),
    unpaywallEmail: z.email().optional(),
    openalexApiKey: z.string().trim().min(1).max(512).regex(/^[^\s]+$/).optional(),
    sites: z.array(siteSchema).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    config.sites.forEach((site, index) => {
      if (ids.has(site.id)) {
        context.addIssue({ code: "custom", path: ["sites", index, "id"], message: "duplicate site id" });
      }
      ids.add(site.id);
    });
  });

export async function loadConfig(path: string): Promise<AppConfig> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return appSchema.parse(raw) as AppConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return appSchema.parse({}) as AppConfig;
    throw error;
  }
}

export function findSite(config: AppConfig, siteId: string): SiteConfig {
  const site = config.sites.find((candidate) => candidate.id === siteId);
  if (!site) {
    throw new Error(`Unknown site_id '${siteId}'. Configured sites: ${config.sites.map((item) => item.id).join(", ")}`);
  }
  return site;
}

export { appSchema, siteSchema };
