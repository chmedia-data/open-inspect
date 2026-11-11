import { vi } from "vitest";
import type { DockerTransport } from "../sandbox/docker-transport";
import { dockerPortalLabels, resolveDockerPortalConfig } from "../sandbox/docker-portals";
import { resolveSandboxPortPlan } from "../sandbox/providers/port-resolution";

export const CONTAINER_ID = "a".repeat(64);
export const PORTAL_TOKEN = "1234567890abcdef1234567890abcdef";
export const PORTAL_HOST = `p3000-${PORTAL_TOKEN}.localhost:8790`;

export function portalFixture() {
  const labels: Record<string, string> = {
    openinspect_framework: "open-inspect",
    openinspect_deployment: "local",
    openinspect_session_id: "session-1",
    openinspect_expected_sandbox_id: "sandbox-1",
    openinspect_kind: "session",
    ...dockerPortalLabels(
      PORTAL_TOKEN,
      resolveSandboxPortPlan(
        { codeServer: true, terminal: true, vnc: true },
        { tunnelPorts: [3000] }
      )
    ),
  };
  const detail = {
    Id: CONTAINER_ID,
    Config: { Labels: labels },
    State: { Running: true },
    HostConfig: { NetworkMode: "sandboxes" },
    NetworkSettings: { Networks: { sandboxes: { IPAddress: "172.20.0.3" } } },
  };
  const request = vi.fn<DockerTransport["request"]>().mockImplementation(async (_method, path) => ({
    status: 200,
    body: path.startsWith("/containers/json?") ? [{ Id: CONTAINER_ID }] : detail,
  }));
  return {
    detail,
    labels,
    request,
    routing: {
      transport: { request },
      deploymentName: "local",
      network: "sandboxes",
      config: resolveDockerPortalConfig({}),
    },
  };
}
