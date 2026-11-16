import { describe, expect, it, vi } from "vitest";
import type { DockerTransport } from "./docker-transport";
import { DOCKER_ORPHAN_GRACE_MS, reapDockerSandboxes } from "./docker-reaper";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-16T12:00:00Z");
const RETENTION = 14 * DAY;

function container(id: string, sessionId: string, state: string, createdMs: number) {
  return {
    Id: id,
    State: state,
    Created: Math.floor(createdMs / 1000),
    Labels: { openinspect_session_id: sessionId },
  };
}

function transportWith(
  list: unknown[],
  finishedAt: Record<string, string>
): { transport: DockerTransport; request: ReturnType<typeof vi.fn<DockerTransport["request"]>> } {
  const request = vi.fn<DockerTransport["request"]>(async (method, path) => {
    if (method === "GET" && path.startsWith("/containers/json")) return { status: 200, body: list };
    if (method === "GET") {
      const id = decodeURIComponent(path.split("/")[2]);
      return {
        status: 200,
        body: { Created: "2026-01-01T00:00:00Z", State: { FinishedAt: finishedAt[id] } },
      };
    }
    return { status: 204, body: null };
  });
  return { transport: { request }, request };
}

describe("reapDockerSandboxes", () => {
  it("keeps paused sessions inside retention and removes expired and orphaned containers", async () => {
    const old = NOW - 30 * DAY;
    const { transport, request } = transportWith(
      [
        container("running-live", "live", "running", old),
        container("paused-recent", "live", "exited", old),
        container("paused-expired", "live", "exited", old),
        container("never-started", "live", "created", old),
        container("orphan-running", "gone", "running", old),
        container("orphan-young", "gone", "running", NOW - DOCKER_ORPHAN_GRACE_MS / 2),
      ],
      {
        "paused-recent": new Date(NOW - 2 * DAY).toISOString(),
        "paused-expired": new Date(NOW - 15 * DAY).toISOString(),
        "never-started": "0001-01-01T00:00:00Z",
      }
    );
    const removed = await reapDockerSandboxes({
      transport,
      deploymentName: "local",
      stoppedRetentionMs: RETENTION,
      sessionExists: async (id) => id === "live",
      nowMs: NOW,
    });
    expect(removed.sort()).toEqual(["never-started", "orphan-running", "paused-expired"]);
    const listPath = request.mock.calls[0][1];
    expect(decodeURIComponent(listPath)).toContain("openinspect_deployment=local");
    expect(listPath).toContain("all=true");
    expect(request).toHaveBeenCalledWith("DELETE", "/containers/paused-expired?force=true&v=true");
  });

  it("fails loudly when the Engine list fails", async () => {
    const transport: DockerTransport = { request: async () => ({ status: 500, body: null }) };
    await expect(
      reapDockerSandboxes({
        transport,
        deploymentName: "local",
        stoppedRetentionMs: RETENTION,
        sessionExists: async () => true,
        nowMs: NOW,
      })
    ).rejects.toThrow("HTTP 500");
  });
});
