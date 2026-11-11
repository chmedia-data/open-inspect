import { describe, expect, it } from "vitest";
import {
  dockerPortalLabels,
  dockerPortalUrl,
  newDockerPortalToken,
  parseDockerPortalHost,
  readDockerPortalLabels,
  resolveDockerPortalConfig,
  requireDockerSandboxNetwork,
} from "./docker-portals";
import { resolveSandboxPortPlan } from "./providers/port-resolution";

describe("Docker portal configuration", () => {
  it.each([undefined, "", "host", "none", "container:app"])(
    "rejects unsafe network %s",
    (network) => {
      expect(() => requireDockerSandboxNetwork(network)).toThrow("DOCKER_SANDBOX_NETWORK");
    }
  );
  it("generates distinct 128-bit tokens and DNS-safe root URLs", () => {
    const token = newDockerPortalToken();
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(newDockerPortalToken()).not.toBe(token);
    const config = resolveDockerPortalConfig({});
    const url = new URL(dockerPortalUrl(config, token, 65535));
    expect(url.hostname.split(".")[0].length).toBeLessThanOrEqual(63);
    expect(url.pathname).toBe("/");
    expect(parseDockerPortalHost(url.host, config)).toEqual({ token, port: 65535 });
  });

  it("supports an external TLS origin with a separate internal listener port", () => {
    const config = resolveDockerPortalConfig({
      DOCKER_PORTAL_PORT: "8791",
      DOCKER_PORTAL_PUBLIC_PORT: "443",
      DOCKER_PORTAL_SCHEME: "https",
      DOCKER_PORTAL_BASE_DOMAIN: "Portals.Example.com",
    });
    const token = "b".repeat(32);
    expect(config.port).toBe(8791);
    expect(dockerPortalUrl(config, token, 3000)).toBe(
      `https://p3000-${token}.portals.example.com:443`
    );
    expect(parseDockerPortalHost(`p3000-${token}.portals.example.com`, config)).toEqual({
      token,
      port: 3000,
    });
  });

  it.each([
    { DOCKER_PORTAL_PORT: "0" },
    { DOCKER_PORTAL_PUBLIC_PORT: "65536" },
    { DOCKER_PORTAL_PUBLIC_PORT: "NaN" },
    { DOCKER_PORTAL_SCHEME: "file" },
    { DOCKER_PORTAL_BASE_DOMAIN: "localhost:8790" },
    { DOCKER_PORTAL_BASE_DOMAIN: "127.0.0.1" },
    { DOCKER_PORTAL_BASE_DOMAIN: "a..example" },
    { DOCKER_PORTAL_BASE_DOMAIN: "*.example.com" },
  ])("rejects invalid config %j", (env) =>
    expect(() => resolveDockerPortalConfig(env)).toThrow("DOCKER_PORTAL_")
  );

  it("round trips enabled services and only the allowed extra ports", () => {
    const plan = resolveSandboxPortPlan(
      { codeServer: true, terminal: true, vnc: true },
      { codeServerPort: 8888, tunnelPorts: [3000, 8888, 7681, 5900, 3000] }
    );
    const token = newDockerPortalToken();
    expect(readDockerPortalLabels(dockerPortalLabels(token, plan))).toEqual({ token, plan });
    expect(plan.extraTunnelPorts).toEqual([3000]);
  });
});
