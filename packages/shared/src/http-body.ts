/** Thrown by `readBodyCapped` when the body does not finish within its deadline. */
export class BodyReadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Body not received within ${timeoutMs}ms`);
    this.name = "BodyReadTimeoutError";
  }
}

/**
 * Buffer a request/response body stream under a hard byte cap: returns the
 * concatenated bytes, an empty array for a missing body, or null once the cap
 * is exceeded (the stream is cancelled at that point). Callers turn the null
 * into their own too-large response. With `timeoutMs`, a body that has not
 * finished by then is cancelled and `BodyReadTimeoutError` is thrown.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMs?: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array();

  const reader = body.getReader();
  // A cancelled read resolves as done, so only this flag tells a cut-off body
  // from a complete one.
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void reader.cancel(new BodyReadTimeoutError(timeoutMs)).catch(() => undefined);
        }, timeoutMs);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new BodyReadTimeoutError(timeoutMs!);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (timedOut) throw new BodyReadTimeoutError(timeoutMs!);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
