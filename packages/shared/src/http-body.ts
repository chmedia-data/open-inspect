/**
 * Buffer a request/response body stream under a hard byte cap: returns the
 * concatenated bytes, an empty array for a missing body, or null once the cap
 * is exceeded (the stream is cancelled at that point). Callers turn the null
 * into their own too-large response.
 *
 * When `signal` aborts (a read deadline, say), the stream is cancelled and the
 * call rejects with the signal's reason; a partial body is never returned.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  options: { signal?: AbortSignal } = {}
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array();
  const { signal } = options;
  signal?.throwIfAborted();

  const reader = body.getReader();
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
