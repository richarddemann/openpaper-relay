import { randomBytes } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PdfTextExtractor } from "./extractor.js";
import {
  type PaperIdentityExpectation,
  type PaperIdentityVerification,
  verifyPaperIdentity,
} from "./paper-identity.js";

export class DownloadedPaperVerifier {
  private readonly verificationDir: string;

  constructor(
    stateRoot: string,
    private readonly extractor: Pick<PdfTextExtractor, "extract">,
  ) {
    this.verificationDir = resolve(stateRoot, "verification");
  }

  async verify(data: Buffer, expected: PaperIdentityExpectation): Promise<PaperIdentityVerification> {
    await mkdir(this.verificationDir, { recursive: true, mode: 0o700 });
    await chmod(this.verificationDir, 0o700);
    const temporary = resolve(this.verificationDir, `${randomBytes(16).toString("hex")}.pdf`);
    try {
      await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
      try {
        const extracted = await this.extractor.extract(temporary);
        return verifyPaperIdentity(extracted.text, expected);
      } catch {
        return {
          status: "inconclusive",
          method: "none",
          doiMatched: expected.doi ? false : null,
          titleTokenCoverage: null,
          authorMatched: null,
          yearMatched: null,
          reason: "text_extraction_unavailable",
        };
      }
    } finally {
      await this.removeTemporary(temporary);
    }
  }

  private async removeTemporary(path: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await unlink(path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        if (attempt === 1) throw new Error("temporary verification file could not be removed");
      }
    }
  }
}
