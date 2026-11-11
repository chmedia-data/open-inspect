import { EventEmitter } from "node:events";
import { request, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDockerTransport } from "./docker-transport";

vi.mock("node:http", () => ({ request: vi.fn() }));

describe("Docker Unix socket transport", () => {
  let options: RequestOptions;
  let response: EventEmitter & { statusCode: number };
  let req: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    response = Object.assign(new EventEmitter(), { statusCode: 200 });
    req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    req.destroy.mockImplementation((error: Error) => req.emit("error", error));
    vi.mocked(request).mockImplementation(((
      config: RequestOptions,
      callback: (res: IncomingMessage) => void
    ) => {
      options = config;
      callback(response as IncomingMessage);
      return req as unknown as ClientRequest;
    }) as typeof request);
  });

  it("uses the configured socket and versioned API with correct UTF-8 JSON framing", async () => {
    const result = createDockerTransport("/run/custom.sock").request("POST", "/containers/create", {
      label: "é",
    });
    expect(options).toMatchObject({
      socketPath: "/run/custom.sock",
      path: "/v1.45/containers/create",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength('{"label":"é"}'),
      },
    });
    expect(options).not.toHaveProperty("hostname");
    expect(req.end).toHaveBeenCalledWith('{"label":"é"}');
    response.emit("data", Buffer.from('{"Id":'));
    response.emit("data", Buffer.from('"container-1"}'));
    response.emit("end");
    await expect(result).resolves.toEqual({ status: 200, body: { Id: "container-1" } });
  });

  it("handles Docker's empty start/stop responses with the default socket", async () => {
    const result = createDockerTransport().request("POST", "/containers/id/start");
    expect(options.socketPath).toBe("/var/run/docker.sock");
    expect(options.headers).toBeUndefined();
    response.statusCode = 204;
    response.emit("end");
    await expect(result).resolves.toEqual({ status: 204, body: null });
  });

  it("rejects invalid JSON without exposing its contents", async () => {
    const result = createDockerTransport().request("GET", "/containers/id/json");
    response.emit("data", Buffer.from("secret"));
    response.emit("end");
    await expect(result).rejects.toThrow("Docker Engine returned invalid JSON");
  });

  it("bounds response memory and propagates socket errors", async () => {
    const oversized = createDockerTransport().request("GET", "/containers/id/json");
    response.emit("data", Buffer.alloc(1024 * 1024 + 1));
    await expect(oversized).rejects.toThrow("exceeded the size limit");
    const disconnected = createDockerTransport().request("GET", "/containers/id/json");
    req.emit("error", Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(disconnected).rejects.toMatchObject({ code: "EACCES" });
  });

  it("passes caller cancellation into the HTTP request and rejects relative socket paths", async () => {
    const controller = new AbortController();
    const result = createDockerTransport().request(
      "POST",
      "/containers/id/stop",
      undefined,
      controller.signal
    );
    expect(options.signal?.aborted).toBe(false);
    controller.abort();
    expect(options.signal?.aborted).toBe(true);
    req.emit("error", new Error("aborted"));
    await expect(result).rejects.toThrow("aborted");
    expect(() => createDockerTransport("docker.sock")).toThrow("absolute Unix socket path");
  });
});
