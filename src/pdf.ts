const PDF_SIGNATURE = Buffer.from("%PDF-");

export function validatePdf(data: Buffer, maxBytes: number): void {
  if (data.byteLength > maxBytes) throw new Error(`PDF exceeds configured ${maxBytes}-byte limit`);
  if (data.byteLength < 100) throw new Error("response is too small to be a PDF");
  const signatureOffset = data.subarray(0, Math.min(1024, data.length)).indexOf(PDF_SIGNATURE);
  if (signatureOffset < 0) throw new Error("response does not contain a PDF signature");
  if (!data.subarray(Math.max(0, data.length - 2048)).includes(Buffer.from("%%EOF"))) {
    throw new Error("response does not contain a PDF end marker");
  }
}
