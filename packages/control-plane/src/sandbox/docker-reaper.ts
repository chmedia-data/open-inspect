import type { DockerTransport } from "./docker-transport";
import { DOCKER_LABELS } from "./docker-portals";
import { dockerSessionListPath } from "./docker-limits";

/** A container this young may belong to a session whose index row is still being written. */
export const DOCKER_ORPHAN_GRACE_MS = 60 * 60 * 1000;
export const DOCKER_REAPER_INTERVAL_MS = 10 * 60 * 1000;

export interface DockerReaperOptions {
  transport: DockerTransport;
  deploymentName: string;
  /** How long a stopped container keeps its paused session resumable. */
  stoppedRetentionMs: number;
  sessionExists(sessionId: string): Promise<boolean>;
  nowMs: number;
}

/**
 * Removes this deployment's session containers that nothing can resume:
 * stopped ones past retention, and any whose session no longer exists.
 * A stopped container inside retention is a paused session and is kept;
 * resuming after removal falls back to a fresh sandbox.
 */
export async function reapDockerSandboxes(options: DockerReaperOptions): Promise<string[]> {
  const { transport, nowMs } = options;
  const list = await transport.request("GET", dockerSessionListPath(options.deploymentName, true));
  if (list.status !== 200 || !Array.isArray(list.body)) {
    throw new Error(`Docker Engine list failed (HTTP ${list.status})`);
  }
  const removed: string[] = [];
  for (const item of list.body as unknown[]) {
    if (!isRecord(item) || typeof item.Id !== "string" || !isRecord(item.Labels)) continue;
    const sessionId = item.Labels[DOCKER_LABELS.sessionId];
    if (typeof sessionId !== "string") continue;
    const createdMs = typeof item.Created === "number" ? item.Created * 1000 : nowMs;
    let reap = false;
    if (nowMs - createdMs >= DOCKER_ORPHAN_GRACE_MS && !(await options.sessionExists(sessionId))) {
      reap = true;
    } else if (item.State !== "running" && item.State !== "restarting" && item.State !== "paused") {
      const stoppedMs = await finishedAtMs(transport, item.Id);
      reap = stoppedMs !== null && nowMs - stoppedMs >= options.stoppedRetentionMs;
    }
    if (!reap) continue;
    const res = await transport.request(
      "DELETE",
      `/containers/${encodeURIComponent(item.Id)}?force=true&v=true`
    );
    if (res.status === 204 || res.status === 404) removed.push(item.Id);
  }
  return removed;
}

/** When the container last stopped; its creation time if it never ran. */
async function finishedAtMs(transport: DockerTransport, id: string): Promise<number | null> {
  const detail = await transport.request("GET", `/containers/${encodeURIComponent(id)}/json`);
  if (detail.status !== 200 || !isRecord(detail.body)) return null;
  const state = detail.body.State;
  const finished = isRecord(state) ? Date.parse(String(state.FinishedAt)) : NaN;
  // Docker reports a never-run container's FinishedAt as the zero time.
  if (Number.isFinite(finished) && finished > 0) return finished;
  const created = Date.parse(String(detail.body.Created));
  return Number.isFinite(created) ? created : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
