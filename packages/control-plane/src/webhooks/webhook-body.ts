import { BodyReadTimeoutError, readBodyCapped } from "@open-inspect/shared/http-body";
import { error } from "../routes/shared";

/** How long a webhook sender has to deliver its whole body. */
export const WEBHOOK_BODY_TIMEOUT_MS = 10_000;

/**
 * Read a webhook body as UTF-8 text under a byte cap and a deadline, so an
 * unauthenticated or slow sender cannot make the control plane buffer an
 * unbounded body. Returns the text or the error response to send.
 */
export async function readWebhookBody(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    return { ok: false, response: error("Payload too large", 413) };
  }
  try {
    const bytes = await readBodyCapped(request.body, maxBytes, WEBHOOK_BODY_TIMEOUT_MS);
    if (bytes === null) return { ok: false, response: error("Payload too large", 413) };
    return { ok: true, text: new TextDecoder().decode(bytes) };
  } catch (e) {
    if (e instanceof BodyReadTimeoutError) {
      return { ok: false, response: error("Request body timed out", 408) };
    }
    throw e;
  }
}
