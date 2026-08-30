import type { PaperIdentityVerification } from "./paper-identity.js";

export interface SiteConfig {
  id: string;
  label: string;
  startUrl: string;
  doiUrlTemplate: string;
  allowedNetworkHosts: string[];
  allowedPaperUrlHosts: string[];
  allowedPdfHosts: string[];
  loginUrlPatterns: string[];
  loginPageSelectors: string[];
  pdfLinkSelectors: string[];
  pdfClickSelectors: string[];
  waitAfterNavigationMs: number;
  navigationTimeoutMs: number;
}

export interface AppConfig {
  maxPdfBytes: number;
  maxDownloadsPerHour: number;
  maxSearchesPerHour: number;
  extractionTimeoutMs: number;
  extractionMaxOldSpaceMb: number;
  unpaywallEmail?: string;
  sites: SiteConfig[];
}

export type FetchResult =
  | {
      status: "downloaded";
      paperId: string;
      resourceUri: string;
      filename: string;
      sizeBytes: number;
      verification: PaperIdentityVerification;
    }
  | {
      status: "login_required";
      siteId: string;
      message: string;
    }
  | {
      status: "not_found";
      siteId: string;
      message: string;
    }
  | {
      status: "verification_failed";
      siteId: string;
      message: string;
      verification: PaperIdentityVerification;
    };

export interface StoredPaper {
  paperId: string;
  path: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
}
