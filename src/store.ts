import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CrossProcessLock } from "./lock.js";
import { safeFilename } from "./security.js";
import { validatePdf } from "./pdf.js";
import type { StoredPaper } from "./types.js";

const PAPER_ID = /^[a-f0-9]{64}$/;

interface ProvenanceEntry {
  retrievedAt: string;
  suggestedFilename: string;
  sourceMetadata?: Record<string, unknown>;
}

interface StoredMetadataRecord {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  sourceMetadata?: Record<string, unknown>;
  provenance?: ProvenanceEntry[];
}

export class PaperStore {
  private readonly documentsDir: string;
  private readonly metadataDir: string;

  constructor(
    private readonly root: string,
    private readonly maxPdfBytes: number,
  ) {
    this.documentsDir = resolve(root, "documents");
    this.metadataDir = resolve(root, "metadata");
  }

  async initialize(): Promise<void> {
    await mkdir(this.documentsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.metadataDir, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await chmod(this.documentsDir, 0o700);
    await chmod(this.metadataDir, 0o700);
  }

  async put(
    data: Buffer,
    suggestedFilename?: string,
    sourceMetadata?: Record<string, unknown>,
  ): Promise<StoredPaper> {
    validatePdf(data, this.maxPdfBytes);
    await this.initialize();
    const paperId = createHash("sha256").update(data).digest("hex");
    const release = await new CrossProcessLock(resolve(this.root, "locks", `paper-${paperId}.lock`)).acquire();
    try {
      return await this.putLocked(paperId, data, suggestedFilename, sourceMetadata);
    } finally {
      await release();
    }
  }

  private async putLocked(
    paperId: string,
    data: Buffer,
    suggestedFilename?: string,
    sourceMetadata?: Record<string, unknown>,
  ): Promise<StoredPaper> {
    const path = this.pdfPath(paperId);
    const suggested = safeFilename(suggestedFilename);
    const retrievedAt = new Date().toISOString();

    let existing: StoredMetadataRecord | undefined;
    try {
      existing = JSON.parse(await readFile(this.metadataPath(paperId), "utf8")) as StoredMetadataRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const filename = existing?.filename ?? suggested;
    const createdAt = existing?.createdAt ?? retrievedAt;
    const record: StoredPaper = { paperId, path, filename, sizeBytes: data.byteLength, createdAt };

    try {
      await stat(path);
    } catch {
      await this.atomicWrite(path, data);
    }
    const legacyProvenance: ProvenanceEntry[] = existing && !existing.provenance
      ? [{
          retrievedAt: existing.createdAt,
          suggestedFilename: existing.filename,
          ...(existing.sourceMetadata ? { sourceMetadata: existing.sourceMetadata } : {}),
        }]
      : [];
    const provenance = [
      ...(existing?.provenance ?? legacyProvenance),
      {
        retrievedAt,
        suggestedFilename: suggested,
        ...(sourceMetadata ? { sourceMetadata } : {}),
      },
    ];
    await this.atomicWrite(this.metadataPath(paperId), Buffer.from(JSON.stringify({
      filename,
      sizeBytes: data.byteLength,
      createdAt,
      provenance,
    }, null, 2)));
    return record;
  }

  async get(paperId: string): Promise<StoredPaper> {
    this.assertPaperId(paperId);
    const metadata = JSON.parse(await readFile(this.metadataPath(paperId), "utf8")) as {
      filename: string;
      sizeBytes: number;
      createdAt: string;
    };
    const path = this.pdfPath(paperId);
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size !== metadata.sizeBytes) throw new Error("stored paper failed integrity metadata check");
    return { paperId, path, ...metadata };
  }

  async read(paperId: string): Promise<Buffer> {
    const record = await this.get(paperId);
    const data = await readFile(record.path);
    validatePdf(data, this.maxPdfBytes);
    if (createHash("sha256").update(data).digest("hex") !== paperId) throw new Error("stored paper failed content hash check");
    return data;
  }

  private pdfPath(paperId: string): string {
    this.assertPaperId(paperId);
    return join(this.documentsDir, `${paperId}.pdf`);
  }

  private metadataPath(paperId: string): string {
    this.assertPaperId(paperId);
    return join(this.metadataDir, `${paperId}.json`);
  }

  private assertPaperId(paperId: string): void {
    if (!PAPER_ID.test(paperId)) throw new Error("invalid paper_id");
  }

  private async atomicWrite(path: string, data: Buffer): Promise<void> {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  }
}
