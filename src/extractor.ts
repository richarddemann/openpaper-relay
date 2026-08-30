import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ExtractedText {
  text: string;
  pages: number;
}

export class PdfTextExtractor {
  private readonly workerPath = fileURLToPath(new URL("../worker/extract-worker.mjs", import.meta.url));

  constructor(
    private readonly timeoutMs: number,
    private readonly maxOldSpaceMb: number,
    private readonly maxTextBytes = 10_000_000,
    private readonly maxDiagnosticBytes = 64_000,
  ) {}

  extract(path: string): Promise<ExtractedText> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${this.maxOldSpaceMb}`, this.workerPath, path], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "" },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let diagnosticBytes = 0;
      let settled = false;

      const finish = (error?: Error, result?: ExtractedText): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result as ExtractedText);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`PDF text extraction exceeded ${this.timeoutMs} ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.maxTextBytes) {
          child.kill("SIGKILL");
          finish(new Error("extracted text exceeds configured output limit"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        diagnosticBytes += chunk.length;
        if (diagnosticBytes > this.maxDiagnosticBytes) {
          child.kill("SIGKILL");
          finish(new Error("PDF extraction exceeded the diagnostic output limit"));
          return;
        }
        stderr.push(chunk);
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error(`PDF extraction failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as ExtractedText;
          if (typeof parsed.text !== "string" || !Number.isInteger(parsed.pages)) throw new Error("invalid worker response");
          finish(undefined, parsed);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("invalid extraction result"));
        }
      });
    });
  }
}
