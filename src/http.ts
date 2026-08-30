export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel("response rejected");
  } catch {
    // Preserve the caller's more useful status or validation error.
  }
}

export async function boundedResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel("response exceeds configured size limit");
    throw new Error("response exceeds configured size limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("response exceeds configured size limit");
        throw new Error("response exceeds configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
