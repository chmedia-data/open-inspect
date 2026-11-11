import { isIPv4 } from "node:net";
import {
  DOCKER_LABELS,
  isDockerSandbox,
  isRecord,
  parseDockerPortalHost,
  readDockerPortalLabels,
  requireDockerSandboxNetwork,
  type DockerPortalConfig,
} from "../sandbox/docker-portals";
import type { DockerTransport } from "../sandbox/docker-transport";

export interface DockerPortalRouting {
  transport: DockerTransport;
  deploymentName: string;
  network: string;
  config: DockerPortalConfig;
}

/** No DNS lookup or user-supplied upstream. A Docker-owned endpoint is the only target. */
export async function resolveDockerPortalTarget(
  routing: DockerPortalRouting,
  host: string | undefined,
  signal?: AbortSignal
): Promise<{ address: string; port: number } | null> {
  const portal = parseDockerPortalHost(host, routing.config);
  if (!portal) return null;
  const filters = {
    label: [
      `${DOCKER_LABELS.framework}=open-inspect`,
      `${DOCKER_LABELS.deployment}=${routing.deploymentName}`,
      `${DOCKER_LABELS.kind}=session`,
      `${DOCKER_LABELS.portalToken}=${portal.token}`,
    ],
  };
  try {
    requireDockerSandboxNetwork(routing.network);
    const list = await routing.transport.request(
      "GET",
      `/containers/json?filters=${encodeURIComponent(JSON.stringify(filters))}`,
      undefined,
      signal
    );
    if (list.status !== 200 || !Array.isArray(list.body) || list.body.length !== 1) return null;
    const candidate: unknown = list.body[0];
    if (
      !isRecord(candidate) ||
      typeof candidate.Id !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.Id)
    )
      return null;
    const response = await routing.transport.request(
      "GET",
      `/containers/${candidate.Id}/json`,
      undefined,
      signal
    );
    const detail = response.body;
    if (
      response.status !== 200 ||
      !isRecord(detail) ||
      detail.Id !== candidate.Id ||
      !isRecord(detail.State) ||
      detail.State.Running !== true ||
      !isRecord(detail.Config) ||
      !isDockerSandbox(detail.Config.Labels, routing.deploymentName) ||
      detail.Config.Labels[DOCKER_LABELS.kind] !== "session" ||
      !isRecord(detail.HostConfig) ||
      detail.HostConfig.NetworkMode !== routing.network ||
      !isRecord(detail.NetworkSettings) ||
      !isRecord(detail.NetworkSettings.Networks)
    )
      return null;
    const access = readDockerPortalLabels(detail.Config.Labels);
    if (
      !access ||
      access.token !== portal.token ||
      !access.plan.allExposedPorts.includes(portal.port)
    )
      return null;
    const endpoint = detail.NetworkSettings.Networks[routing.network];
    if (
      !isRecord(endpoint) ||
      typeof endpoint.IPAddress !== "string" ||
      !privateBridgeAddress(endpoint.IPAddress)
    )
      return null;
    return { address: endpoint.IPAddress, port: portal.port };
  } catch {
    // A lookup failure exposes no Docker details and never falls back to a host route.
    return null;
  }
}

function privateBridgeAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
