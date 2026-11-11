import { describe, expect, it } from "vitest";
import { resolveDockerPortalTarget } from "./docker-portal-routing";
import {
  CONTAINER_ID,
  PORTAL_HOST,
  PORTAL_TOKEN,
  portalFixture,
} from "./docker-portal.test-helpers";

describe("Docker portal routing boundary", () => {
  it.each([3000, 8080, 7680, 6080])(
    "routes enabled application or service port %s",
    async (port) => {
      const { routing } = portalFixture();
      expect(
        await resolveDockerPortalTarget(routing, PORTAL_HOST.replace("p3000-", `p${port}-`))
      ).toEqual({ address: "172.20.0.3", port });
    }
  );
  it("filters Docker by token and deployment, then verifies the running sandbox endpoint", async () => {
    const { routing, request } = portalFixture();
    expect(await resolveDockerPortalTarget(routing, PORTAL_HOST)).toEqual({
      address: "172.20.0.3",
      port: 3000,
    });
    expect(request.mock.calls[0][0]).toBe("GET");
    const filters = JSON.parse(decodeURIComponent(request.mock.calls[0][1].split("filters=")[1]));
    expect(filters.label).toEqual(
      expect.arrayContaining([
        "openinspect_framework=open-inspect",
        "openinspect_deployment=local",
        "openinspect_kind=session",
        `openinspect_portal_token=${PORTAL_TOKEN}`,
      ])
    );
    expect(request.mock.calls[1][1]).toBe(`/containers/${CONTAINER_ID}/json`);
  });

  it.each([
    [
      "wrong token",
      (f: ReturnType<typeof portalFixture>) => {
        f.labels.openinspect_portal_token = "f".repeat(32);
      },
    ],
    [
      "disallowed port",
      (f: ReturnType<typeof portalFixture>) => {
        f.labels.openinspect_portal_allowed_ports = "[8080,7680,6080]";
      },
    ],
    [
      "non-sandbox container",
      (f: ReturnType<typeof portalFixture>) => {
        f.labels.openinspect_framework = "object-store";
      },
    ],
    [
      "another deployment",
      (f: ReturnType<typeof portalFixture>) => {
        f.labels.openinspect_deployment = "other";
      },
    ],
    [
      "missing session identity",
      (f: ReturnType<typeof portalFixture>) => {
        f.labels.openinspect_session_id = "";
      },
    ],
    [
      "build container",
      (f: ReturnType<typeof portalFixture>) => {
        f.labels.openinspect_kind = "image-build";
      },
    ],
    [
      "stopped container",
      (f: ReturnType<typeof portalFixture>) => {
        f.detail.State.Running = false;
      },
    ],
    [
      "host networking",
      (f: ReturnType<typeof portalFixture>) => {
        f.detail.HostConfig.NetworkMode = "host";
      },
    ],
    [
      "container network sharing",
      (f: ReturnType<typeof portalFixture>) => {
        f.detail.HostConfig.NetworkMode = "container:app";
      },
    ],
    [
      "different network",
      (f: ReturnType<typeof portalFixture>) => {
        f.routing.network = "other";
      },
    ],
    [
      "missing endpoint",
      (f: ReturnType<typeof portalFixture>) => {
        f.detail.NetworkSettings.Networks = {} as typeof f.detail.NetworkSettings.Networks;
      },
    ],
    [
      "malformed ports",
      (f: ReturnType<typeof portalFixture>) => {
        f.labels.openinspect_portal_allowed_ports = '["3000"]';
      },
    ],
  ])("refuses %s even if Docker's list returns a candidate", async (_name, mutate) => {
    const fixture = portalFixture();
    mutate(fixture);
    expect(await resolveDockerPortalTarget(fixture.routing, PORTAL_HOST)).toBeNull();
  });

  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "app",
    "object-store",
    "8.8.8.8",
    "::1",
    "172.20.0.3:8787",
  ])("never routes to %s", async (address) => {
    const { routing, detail } = portalFixture();
    detail.NetworkSettings.Networks.sandboxes.IPAddress = address;
    expect(await resolveDockerPortalTarget(routing, PORTAL_HOST)).toBeNull();
  });

  it.each([
    undefined,
    "localhost:8790",
    "app:8787",
    `${PORTAL_HOST}.evil`,
    `http://${PORTAL_HOST}`,
    `p3000-short.localhost:8790`,
    `p03000-${PORTAL_TOKEN}.localhost:8790`,
    `p65536-${PORTAL_TOKEN}.localhost:8790`,
    `p3000-${PORTAL_TOKEN}.localhost:8787`,
  ])("rejects invalid Host %s without contacting Docker", async (host) => {
    const { routing, request } = portalFixture();
    expect(await resolveDockerPortalTarget(routing, host)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed on absent, ambiguous, or unavailable containers", async () => {
    const { routing, request } = portalFixture();
    request.mockResolvedValueOnce({ status: 200, body: [] });
    expect(await resolveDockerPortalTarget(routing, PORTAL_HOST)).toBeNull();
    request.mockResolvedValueOnce({
      status: 200,
      body: [{ Id: CONTAINER_ID }, { Id: "b".repeat(64) }],
    });
    expect(await resolveDockerPortalTarget(routing, PORTAL_HOST)).toBeNull();
    request.mockRejectedValueOnce(new Error("daemon unavailable"));
    expect(await resolveDockerPortalTarget(routing, PORTAL_HOST)).toBeNull();
  });
});
