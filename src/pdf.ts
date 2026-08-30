import { readFile, stat } from "node:fs/promises";

const PDF_SIGNATURE = Buffer.from("%PDF-");

export function assertDeclaredPdfLength(value: string | undefined, maxBytes: number): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("browser PDF response is missing a valid Content-Length");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error("browser PDF response has an invalid Content-Length");
  }
  if (length > maxBytes) throw new Error("PDF response exceeds configured size limit");
  return length;
}

export async function readPdfFileWithinLimit(path: string, maxBytes: number): Promise<Buffer> {
  const file = await stat(path);
  if (!file.isFile()) throw new Error("browser download did not produce a regular file");
  if (file.size > maxBytes) throw new Error("PDF download exceeds configured size limit");
  return readFile(path);
}

export function validatePdf(data: Buffer, maxBytes: number): void {
  if (data.byteLength > maxBytes) throw new Error(`PDF exceeds configured ${maxBytes}-byte limit`);
  if (data.byteLength < 100) throw new Error("response is too small to be a PDF");
  const signatureOffset = data.subarray(0, Math.min(1024, data.length)).indexOf(PDF_SIGNATURE);
  if (signatureOffset < 0) throw new Error("response does not contain a PDF signature");
  if (!data.subarray(Math.max(0, data.length - 2048)).includes(Buffer.from("%%EOF"))) {
    throw new Error("response does not contain a PDF end marker");
  }
}
