import {
  IncomingMessage,
  ServerResponse,
  type ClientRequest,
  type request as HttpRequest,
} from "node:http";
import type { Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockerPortalServer } from "./docker-portal-server";
import { PORTAL_HOST, portalFixture } from "./docker-portal.test-helpers";

/** Two independent stream directions, so bidirectional piping cannot echo into itself. */
class Wire extends Duplex {
  readonly writes: Buffer[] = [];
  _read(): void {}
  _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.writes.push(Buffer.from(chunk));
    done();
  }
  get text(): string {
    return Buffer.concat(this.writes).toString();
  }
}

function incoming(host = PORTAL_HOST, path = "/") {
  const wire = new Wire();
  const message = new IncomingMessage(wire as unknown as Socket);
  message.method = "GET";
  message.url = path;
  message.httpVersion = "1.1";
  message.httpVersionMajor = 1;
  message.httpVersionMinor = 1;
  message.complete = true;
  message.headers = { host };
  return { wire, message };
}

describe("Docker portal HTTP and WebSocket forwarding", () => {
  const portals: ReturnType<typeof createDockerPortalServer>[] = [];
  afterEach(() => {
    for (const portal of portals.splice(0)) portal.close();
  });

  function fixture() {
    const docker = portalFixture();
    const outgoing = new PassThrough();
    const sent: Buffer[] = [];
    outgoing.on("data", (chunk: Buffer) => sent.push(chunk));
    const request = vi.fn(() => outgoing as unknown as ClientRequest);
    const portal = createDockerPortalServer(
      docker.routing,
      request as unknown as typeof HttpRequest
    );
    portals.push(portal);
    return { ...docker, outgoing, sent, proxyRequest: request, portal };
  }

  it("streams HTTP bodies and root paths to only the verified private IP", async () => {
    const { portal, proxyRequest, outgoing, sent } = fixture();
    const { wire, message } = incoming(PORTAL_HOST, "/assets/test?query=1");
    message.method = "POST";
    message.headers = {
      ...message.headers,
      connection: "keep-alive, x-hop",
      "x-hop": "remove",
      "x-forwarded-host": "object-store",
      "x-forwarded-proto": "file",
      forwarded: "host=app",
      "content-length": "7",
      authorization: "application-credential",
    };
    const response = new ServerResponse(message);
    response.assignSocket(wire as unknown as Socket);
    portal.server.emit("request", message, response);
    message.push("payload");
    message.push(null);
    await vi.waitFor(() => expect(proxyRequest).toHaveBeenCalledOnce());
    const options = proxyRequest.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(options[0]).toMatchObject({
      hostname: "172.20.0.3",
      port: 3000,
      path: "/assets/test?query=1",
      method: "POST",
      agent: false,
      headers: {
        host: PORTAL_HOST,
        "x-forwarded-host": PORTAL_HOST,
        "x-forwarded-proto": "http",
        "x-forwarded-port": "8790",
        authorization: "application-credential",
      },
    });
    expect(options[0].headers).not.toHaveProperty("x-hop");
    expect(options[0].headers).not.toHaveProperty("forwarded");
    expect(Buffer.concat(sent).toString()).toBe("payload");
    const upstream = incoming().message;
    upstream.statusCode = 200;
    upstream.headers = {
      "content-length": "6",
      connection: "x-internal",
      "x-internal": "remove",
      "set-cookie": ["app=1; Path=/"],
    };
    outgoing.emit("response", upstream);
    upstream.push("result");
    upstream.push(null);
    await vi.waitFor(() => expect(wire.text).toContain("result"));
    expect(wire.text).toContain("200 OK");
    expect(wire.text).toContain("referrer-policy: no-referrer");
    expect(wire.text).toContain("set-cookie: app=1; Path=/");
    expect(wire.text).not.toContain("x-internal");
    wire.destroy();
  });

  it.each(["localhost:8790", PORTAL_HOST.replace("p3000-", "p8787-")])(
    "answers opaque 404 for %s without opening an upstream",
    async (host) => {
      const { portal, proxyRequest } = fixture();
      const { wire, message } = incoming(host, "/sessions");
      const response = new ServerResponse(message);
      response.assignSocket(wire as unknown as Socket);
      portal.server.emit("request", message, response);
      await vi.waitFor(() => expect(wire.text).toContain("404 Not Found"));
      expect(proxyRequest).not.toHaveBeenCalled();
      expect(wire.text).toMatch(/\r\n\r\n$/);
      wire.destroy();
    }
  );

  it("does not implement an HTTP forward proxy or CONNECT tunnel", async () => {
    const { portal, proxyRequest, request } = fixture();
    const { wire, message } = incoming(PORTAL_HOST, "http://169.254.169.254/latest/meta-data");
    const response = new ServerResponse(message);
    response.assignSocket(wire as unknown as Socket);
    portal.server.emit("request", message, response);
    await vi.waitFor(() => expect(wire.text).toContain("404 Not Found"));
    const connection = incoming();
    connection.message.method = "CONNECT";
    portal.server.emit("connect", connection.message, connection.wire, Buffer.alloc(0));
    expect(connection.wire.text).toContain("404 Not Found");
    expect(request).not.toHaveBeenCalled();
    expect(proxyRequest).not.toHaveBeenCalled();
    wire.destroy();
    connection.wire.destroy();
  });

  it("forwards a WebSocket handshake, both head buffers, and frames in both directions", async () => {
    const { portal, proxyRequest, outgoing } = fixture();
    const { wire, message } = incoming(PORTAL_HOST, "/ws?token=terminal-jwt");
    message.headers = {
      ...message.headers,
      connection: "Upgrade",
      upgrade: "websocket",
      origin: `http://${PORTAL_HOST}`,
      "sec-websocket-key": "client-key",
      "sec-websocket-protocol": "tty",
    };
    portal.server.emit("upgrade", message, wire, Buffer.from("client-head"));
    await vi.waitFor(() => expect(proxyRequest).toHaveBeenCalledOnce());
    expect(proxyRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "172.20.0.3",
        port: 3000,
        path: "/ws?token=terminal-jwt",
        headers: expect.objectContaining({
          host: PORTAL_HOST,
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "client-key",
          "sec-websocket-protocol": "tty",
        }),
      })
    );
    const upstreamWire = new Wire();
    const upstream = incoming().message;
    upstream.statusCode = 101;
    upstream.headers = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-accept": "server-key",
      "sec-websocket-protocol": "tty",
    };
    outgoing.emit("upgrade", upstream, upstreamWire, Buffer.from("server-head"));
    wire.push("client-frame");
    upstreamWire.push("server-frame");
    await vi.waitFor(() => expect(upstreamWire.text).toBe("client-headclient-frame"));
    expect(wire.text).toContain("101 Switching Protocols");
    expect(wire.text).toContain("sec-websocket-accept: server-key");
    expect(wire.text).toContain("sec-websocket-protocol: tty");
    expect(wire.text).toMatch(/server-headserver-frame$/);
    portal.close();
    expect(wire.destroyed).toBe(true);
    expect(upstreamWire.destroyed).toBe(true);
  });

  it("relays an upstream that refuses the upgrade instead of masking it as 502", async () => {
    const { portal, proxyRequest, outgoing } = fixture();
    const { wire, message } = incoming(PORTAL_HOST, "/ws");
    message.headers = { ...message.headers, connection: "Upgrade", upgrade: "websocket" };
    portal.server.emit("upgrade", message, wire, Buffer.alloc(0));
    await vi.waitFor(() => expect(proxyRequest).toHaveBeenCalledOnce());
    const refusal = incoming().message;
    refusal.statusCode = 401;
    refusal.headers = {
      "content-length": "6",
      "www-authenticate": "Basic",
      connection: "x-internal",
      "x-internal": "remove",
    };
    outgoing.emit("response", refusal);
    refusal.push("denied");
    refusal.push(null);
    await vi.waitFor(() => expect(wire.writableEnded).toBe(true));
    expect(wire.text).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    expect(wire.text).toContain("www-authenticate: Basic");
    expect(wire.text).toContain("connection: close");
    expect(wire.text).not.toContain("x-internal");
    expect(wire.text).toMatch(/\r\n\r\ndenied$/);
  });

  it("applies the same authorization to upgrades and refuses other upgrade protocols", async () => {
    const { portal, proxyRequest } = fixture();
    const { wire, message } = incoming(PORTAL_HOST.replace("p3000-", "p8787-"));
    message.headers.upgrade = "websocket";
    portal.server.emit("upgrade", message, wire, Buffer.alloc(0));
    await vi.waitFor(() => expect(wire.text).toContain("404 Not Found"));
    expect(proxyRequest).not.toHaveBeenCalled();
    const other = incoming();
    other.message.headers.upgrade = "h2c";
    portal.server.emit("upgrade", other.message, other.wire, Buffer.alloc(0));
    expect(other.wire.text).toContain("404 Not Found");
  });
});
