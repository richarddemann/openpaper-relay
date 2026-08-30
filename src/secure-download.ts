import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import { filenameFromContentDisposition, ipIsPublic, safeFilename } from "./security.js";
import { validatePdf } from "./pdf.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface DownloadedPdfBytes {
  data: Buffer;
  filename: string;
}

type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
type PinnedRequester = (url: URL, options: RequestOptions) => Promise<IncomingMessage>;

function assertPublicHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("PDF source must be an HTTPS URL without credentials or a nonstandard port");
  }
  return url;
}

export function createPinnedLookup(selected: { address: string; family: number }): LookupFunction {
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const all = typeof options === "object" && options !== null && "all" in options && options.all === true;
    if (all) callback(null, [{ address: selected.address, family: selected.family }]);
    else callback(null, selected.address, selected.family);
  }) as LookupFunction;
}

export class SecurePdfDownloader {
  constructor(
    private readonly maxPdfBytes: number,
    private readonly timeoutMs = 30_000,
    private readonly resolver: DnsResolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
    private readonly dnsTimeoutMs = Math.min(timeoutMs, 5_000),
    private readonly requester?: PinnedRequester,
  ) {}

  async download(initialUrl: string): Promise<DownloadedPdfBytes> {
    let url = assertPublicHttpsUrl(initialUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await this.getPinned(url);
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location) throw new Error("PDF source redirected without a location");
        url = assertPublicHttpsUrl(new URL(location, url).href);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new Error(`PDF source returned HTTP ${status}`);
      }
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/pdf")) {
        response.destroy();
        throw new Error("PDF source did not return application/pdf");
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > this.maxPdfBytes) {
        response.destroy();
        throw new Error("PDF source exceeds configured size limit");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.byteLength;
        if (size > this.maxPdfBytes) {
          response.destroy();
          throw new Error("PDF source exceeds configured size limit");
        }
        chunks.push(buffer);
      }
      const data = Buffer.concat(chunks, size);
      validatePdf(data, this.maxPdfBytes);
      return {
        data,
        filename: safeFilename(filenameFromContentDisposition(response.headers["content-disposition"])),
      };
    }
    throw new Error("PDF source exceeded the redirect limit");
  }

  private async getPinned(url: URL) {
    const addresses = await this.resolveAddresses(url.hostname);
    if (addresses.length === 0) throw new Error(`PDF source did not resolve: ${url.hostname}`);
    if (addresses.some(({ address }) => !ipIsPublic(address))) {
      throw new Error(`PDF source resolved to a non-public address: ${url.hostname}`);
    }
    const selected = addresses[0];
    if (!selected) throw new Error(`PDF source did not resolve: ${url.hostname}`);
    const options: RequestOptions = {
      method: "GET",
      lookup: createPinnedLookup(selected),
      headers: {
        accept: "application/pdf",
        "user-agent": "openpaper-relay/1.2",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (this.requester) return this.requester(url, options);
    return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const outgoing = request(url, options, resolve);
      outgoing.setTimeout(this.timeoutMs, () => outgoing.destroy(new Error("PDF source request timed out")));
      outgoing.once("error", reject);
      outgoing.end();
    });
  }

  private resolveAddresses(hostname: string): Promise<Array<{ address: string; family: number }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`DNS resolution timed out: ${hostname}`)), this.dnsTimeoutMs);
      this.resolver(hostname).then(
        (addresses) => {
          clearTimeout(timer);
          resolve(addresses);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
