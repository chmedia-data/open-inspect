import { request } from "node:http";
import type { DockerTransport } from "../sandbox/docker-transport";

const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DOCKER_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Docker Engine 26+; no TCP fallback and no Docker CLI subprocess. */
export function createDockerTransport(socketPath = DEFAULT_DOCKER_SOCKET_PATH): DockerTransport {
  if (!socketPath.startsWith("/")) {
    throw new Error("DOCKER_SOCKET_PATH must be an absolute Unix socket path");
  }
  return {
    async request(method, path, body, signal) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const deadline = AbortSignal.timeout(DOCKER_REQUEST_TIMEOUT_MS);
      return new Promise((resolve, reject) => {
        const req = request(
          {
            socketPath,
            path: `/v1.45${path}`,
            method,
            signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
            headers: payload
              ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
              : undefined,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_RESPONSE_BYTES) {
                req.destroy(new Error("Docker Engine response exceeded the size limit"));
              } else {
                chunks.push(chunk);
              }
            });
            res.on("error", reject);
            res.on("end", () => {
              try {
                const raw = Buffer.concat(chunks).toString("utf8");
                resolve({ status: res.statusCode ?? 500, body: raw ? JSON.parse(raw) : null });
              } catch {
                reject(new Error("Docker Engine returned invalid JSON"));
              }
            });
          }
        );
        req.on("error", reject);
        req.end(payload);
      });
    },
  };
}
