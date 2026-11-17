import { afterEach, describe, expect, it, vi } from "vitest";
import { readWebhookBody, WEBHOOK_BODY_TIMEOUT_MS } from "./webhook-body";

function post(body: BodyInit | ReadableStream<Uint8Array>, headers: HeadersInit = {}): Request {
  return new Request("https://test.local/webhooks/x", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readWebhookBody", () => {
  it("returns the body as text", async () => {
    expect(await readWebhookBody(post('{"a":"é"}'), 64)).toEqual({ ok: true, text: '{"a":"é"}' });
  });

  it("rejects a declared oversized body without reading it", async () => {
    const pull = vi.fn();
    const result = await readWebhookBody(
      post(new ReadableStream({ pull }), { "content-length": "65" }),
      64
    );
    expect(result.ok || result.response.status).toBe(413);
  });

  it("counts bytes, not characters", async () => {
    const result = await readWebhookBody(post("é".repeat(40)), 64);
    expect(result.ok || result.response.status).toBe(413);
  });

  it("stops reading a chunked body once it passes the cap", async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(32));
      },
    });
    const result = await readWebhookBody(post(body), 64);
    expect(result.ok || result.response.status).toBe(413);
    expect(chunks).toBeLessThan(10);
  });

  it("gives up on a body that is still arriving at the deadline", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1));
      },
    });
    const pending = readWebhookBody(post(body), 64);
    await vi.advanceTimersByTimeAsync(WEBHOOK_BODY_TIMEOUT_MS);
    const result = await pending;
    expect(result.ok || result.response.status).toBe(408);
  });
});
