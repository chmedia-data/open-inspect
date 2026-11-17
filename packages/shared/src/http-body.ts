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
 * into their own too-large response.
 *
 * The third argument is either a `timeoutMs` number or `{ signal }`. With a
 * timeout, a body that has not finished by then is cancelled and
 * `BodyReadTimeoutError` is thrown. When `signal` aborts, the stream is
 * cancelled and the call rejects with the signal's reason. A partial body is
 * never returned.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  limit: number | { signal?: AbortSignal } = {}
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array();
  const timeoutMs = typeof limit === "number" ? limit : undefined;
  const signal = typeof limit === "number" ? undefined : limit.signal;
  signal?.throwIfAborted();

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
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new BodyReadTimeoutError(timeoutMs!);
      signal?.throwIfAborted();
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
