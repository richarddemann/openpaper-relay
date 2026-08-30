import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export type Lookup = typeof dnsLookup;

const DOI_PATTERN = /^10\.\d{4,9}\/[\x21-\x7e]+$/i;

export interface ResolvedIdentifier {
  kind: "doi" | "url";
  url: URL;
}

export function normalizeIdentifier(identifier: string, doiUrlTemplate: string): ResolvedIdentifier {
  const value = identifier.trim();
  if (DOI_PATTERN.test(value)) {
    return { kind: "doi", url: new URL(doiUrlTemplate.replace("{doi}", encodeURIComponent(value))) };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("identifier must be a DOI beginning with 10. or an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("only HTTPS paper URLs are accepted");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not accepted");
  }
  return { kind: "url", url };
}

export function hostIsAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((allowed) => normalized === allowed);
}

export function ipIsPublic(address: string): boolean {
  let parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

export async function assertAllowedUrl(
  value: string | URL,
  allowedHosts: readonly string[],
  lookup: Lookup = dnsLookup,
): Promise<URL> {
  const url = typeof value === "string" ? new URL(value) : value;
  if (url.protocol !== "https:") throw new Error("blocked non-HTTPS URL");
  if (url.username || url.password) throw new Error("blocked URL containing credentials");
  if (url.port && url.port !== "443") throw new Error("blocked non-standard HTTPS port");
  if (isIP(url.hostname)) throw new Error("blocked literal IP address");
  if (!hostIsAllowed(url.hostname, allowedHosts)) throw new Error(`blocked non-allowlisted host: ${url.hostname}`);

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`host did not resolve: ${url.hostname}`);
  if (addresses.some(({ address }) => !ipIsPublic(address))) {
    throw new Error(`blocked host resolving to a non-public address: ${url.hostname}`);
  }
  return url;
}

export function assertAllowedRequestUrl(value: string | URL, allowedHosts: readonly string[]): URL {
  const url = typeof value === "string" ? new URL(value) : value;
  if (url.protocol !== "https:") throw new Error("blocked non-HTTPS request");
  if (url.username || url.password) throw new Error("blocked request URL containing credentials");
  if (url.port && url.port !== "443") throw new Error("blocked request to a non-standard HTTPS port");
  if (isIP(url.hostname)) throw new Error("blocked request to a literal IP address");
  if (!hostIsAllowed(url.hostname, allowedHosts)) throw new Error(`blocked request to non-allowlisted host: ${url.hostname}`);
  return url;
}

export async function assertAllowedDownloadUrl(
  value: string | URL,
  allowedHosts: readonly string[],
  lookup: Lookup = dnsLookup,
): Promise<URL> {
  const url = typeof value === "string" ? new URL(value) : value;
  if (url.protocol === "blob:") {
    if (url.origin === "null") throw new Error("blocked blob download without a trustworthy origin");
    await assertAllowedUrl(new URL(url.origin), allowedHosts, lookup);
    return url;
  }
  return assertAllowedUrl(url, allowedHosts, lookup);
}

export function safeFilename(suggested: string | undefined): string {
  const basename = (suggested ?? "paper.pdf").split(/[\\/]/).at(-1) ?? "paper.pdf";
  const cleaned = basename.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned || "paper"}.pdf`;
}

export function filenameFromContentDisposition(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1];
  const filename = utf8 ?? plain;
  if (!filename) return undefined;
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}
