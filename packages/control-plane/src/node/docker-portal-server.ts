import {
  STATUS_CODES,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { resolveDockerPortalTarget, type DockerPortalRouting } from "./docker-portal-routing";

const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;
const ROUTING_TIMEOUT_MS = 5_000;
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function endSocket(socket: Duplex, status = 404): void {
  socket.end(
    `HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Bad Gateway"}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`
  );
}

function endResponse(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Length": "0" });
  response.end();
}

function cleanHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const nominated = String(headers.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((name) => name.trim());
  for (const name of [...HOP_HEADERS, ...nominated]) delete result[name];
  return result;
}

function proxyHeaders(
  request: IncomingMessage,
  routing: DockerPortalRouting,
  upgrade: boolean
): IncomingHttpHeaders {
  const headers = cleanHeaders(request.headers);
  for (const name of Object.keys(headers)) {
    if (name === "forwarded" || name.startsWith("x-forwarded-")) delete headers[name];
  }
  // Preserve the public authority so root paths, cookies and same-origin checks work.
  headers.host = request.headers.host;
  headers["x-forwarded-host"] = request.headers.host;
  headers["x-forwarded-proto"] = routing.config.scheme;
  headers["x-forwarded-port"] = String(routing.config.publicPort);
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

function validRequest(request: IncomingMessage): boolean {
  // Origin-form only. Never interpret an absolute URL as a proxy destination.
  return (
    !!request.url?.startsWith("/") && !request.url.startsWith("//") && request.method !== "CONNECT"
  );
}

/** A separate listener with no control-plane routes, including on invalid portal hosts. */
export function createDockerPortalServer(
  routing: DockerPortalRouting,
  requestUpstream: typeof httpRequest = httpRequest
) {
  const sockets = new Set<Duplex>();
  const pending = new Set<AbortController>();
  const upstreamRequests = new Set<ReturnType<typeof httpRequest>>();
  let closed = false;
  const trackSocket = (socket: Duplex): void => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };

  async function targetFor(request: IncomingMessage, peer: Duplex | ServerResponse) {
    if (closed || !validRequest(request)) return null;
    const controller = new AbortController();
    pending.add(controller);
    const abort = () => controller.abort();
    peer.once("close", abort);
    try {
      return await resolveDockerPortalTarget(
        routing,
        request.headers.host,
        AbortSignal.any([controller.signal, AbortSignal.timeout(ROUTING_TIMEOUT_MS)])
      );
    } finally {
      pending.delete(controller);
      peer.off("close", abort);
    }
  }

  function upstream(request: IncomingMessage, address: string, port: number, upgrade: boolean) {
    const outgoing = requestUpstream({
      hostname: address,
      port,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request, routing, upgrade),
      agent: false,
    });
    upstreamRequests.add(outgoing);
    outgoing.once("close", () => upstreamRequests.delete(outgoing));
    // Bound connection/header waits without timing out idle WebSockets or event streams.
    const timer = setTimeout(
      () => outgoing.destroy(new Error("Portal upstream unavailable")),
      UPSTREAM_HEADERS_TIMEOUT_MS
    );
    outgoing.once("response", () => clearTimeout(timer));
    outgoing.once("upgrade", () => clearTimeout(timer));
    outgoing.once("close", () => clearTimeout(timer));
    return outgoing;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.on("error", () => response.destroy());
    const target = await targetFor(request, response);
    if (closed || response.destroyed) return;
    if (!target) {
      endResponse(response, 404);
      return;
    }
    const outgoing = upstream(request, target.address, target.port, false);
    outgoing.on("error", () => endResponse(response, 502));
    request.on("error", () => outgoing.destroy());
    request.on("aborted", () => outgoing.destroy());
    response.once("close", () => outgoing.destroy());
    outgoing.on("response", (incoming) => {
      if (response.destroyed) {
        incoming.destroy();
        return;
      }
      const headers = cleanHeaders(incoming.headers);
      headers["referrer-policy"] = "no-referrer";
      response.writeHead(incoming.statusCode ?? 502, headers);
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    request.pipe(outgoing);
  }

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    trackSocket(socket);
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      endSocket(socket);
      return;
    }
    const target = await targetFor(request, socket);
    if (closed || socket.destroyed) return;
    if (!target) {
      endSocket(socket);
      return;
    }
    const outgoing = upstream(request, target.address, target.port, true);
    let upgraded = false;
    outgoing.on("error", () => (upgraded ? socket.destroy() : endSocket(socket, 502)));
    socket.once("close", () => outgoing.destroy());
    // The upstream answered with an ordinary response, refusing the upgrade
    // (ttyd's 401 without a terminal token, an app's redirect). Relay it as
    // sent, so the client sees the real refusal, then close the connection.
    outgoing.on("response", (incoming) => {
      if (closed || socket.destroyed) {
        incoming.resume();
        return;
      }
      const status = incoming.statusCode ?? 502;
      const headers = cleanHeaders(incoming.headers);
      headers.connection = "close";
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        value === undefined
          ? []
          : (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}\r\n`)
      );
      socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n${lines.join("")}\r\n`);
      incoming.pipe(socket);
    });
    outgoing.on("upgrade", (incoming, upstreamSocket, upstreamHead) => {
      if (closed || socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      upgraded = true;
      trackSocket(upstreamSocket);
      const headers = cleanHeaders(incoming.headers);
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        value === undefined
          ? []
          : (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}\r\n`)
      );
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("")}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.once("close", () => upstreamSocket.destroy());
      upstreamSocket.once("close", () => socket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    outgoing.end();
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => endResponse(response, 502));
  });
  server.on("connection", trackSocket);
  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch(() => endSocket(socket, 502));
  });
  server.on("connect", (_request, socket) => endSocket(socket));
  server.on("clientError", (_error, socket) => socket.destroy());

  return {
    server,
    /** Stop new requests and cut upgrades too, which server.closeAllConnections omits. */
    close(): void {
      closed = true;
      for (const controller of pending) controller.abort();
      for (const request of upstreamRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
