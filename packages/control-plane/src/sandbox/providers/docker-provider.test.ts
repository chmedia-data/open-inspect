import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerTransport } from "../docker-transport";
import type { CreateSandboxConfig, StopConfig } from "../provider";
import { DockerSandboxProvider, sandboxFacingConfig } from "./docker-provider";
import {
  buildSandboxEnvVars,
  scmCloneIdentity,
  deriveCodeServerPassword,
  deriveVncPassword,
} from "../sandbox-env";
import { resolveDockerPortalConfig } from "../docker-portals";

const config: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  repoOwner: "group/subgroup",
  repoName: "repo",
  controlPlaneUrl: "https://public.example",
  sandboxAuthToken: "auth-token",
  harness: "opencode",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  branch: "main",
};
const stopConfig: StopConfig = {
  providerObjectId: "container-1",
  sessionId: "session-1",
  reason: "inactivity_timeout",
  intent: "preserve",
};

describe("sandboxFacingConfig", () => {
  const proxied = {
    id: "srv-1",
    name: "data",
    type: "remote" as const,
    url: "https://public.example/sessions/session-1/mcp/srv-1",
    enabled: true,
    headers: { Authorization: "Bearer sandbox-token" },
    managed_proxy: { version: 1, auth_mode: "user_oauth" as const, auth_revision: 1 },
  };
  const direct = {
    id: "srv-2",
    name: "docs",
    type: "remote" as const,
    url: "https://mcp.example.com/mcp",
    enabled: true,
  };
  const local = {
    id: "srv-3",
    name: "fs",
    type: "local" as const,
    command: ["npx", "x"],
    enabled: true,
  };

  it("moves the callback and control-plane MCP proxy URLs onto the Docker network", () => {
    const result = sandboxFacingConfig(
      { ...config, mcpServers: [proxied, direct, local] as CreateSandboxConfig["mcpServers"] },
      "http://app:8787/"
    );
    expect(result.controlPlaneUrl).toBe("http://app:8787/");
    expect(result.mcpServers).toEqual([
      { ...proxied, url: "http://app:8787/sessions/session-1/mcp/srv-1" },
      direct,
      local,
    ]);
  });

  it("leaves a lookalike host and an unconfigured override untouched", () => {
    const lookalike = { ...proxied, url: "https://public.example.evil/sessions/x/mcp/y" };
    const input = { ...config, mcpServers: [lookalike] as CreateSandboxConfig["mcpServers"] };
    expect(sandboxFacingConfig(input, "http://app:8787").mcpServers).toEqual([lookalike]);
    expect(sandboxFacingConfig(input, undefined)).toBe(input);
  });
});

describe("DockerSandboxProvider", () => {
  it("does not let repository secrets opt other providers into plaintext callbacks", () => {
    expect(
      buildSandboxEnvVars(
        { ...config, userEnvVars: { OI_ALLOW_HTTP_CONTROL_PLANE: "true" } },
        { scmIdentity: scmCloneIdentity("github") }
      )
    ).not.toHaveProperty("OI_ALLOW_HTTP_CONTROL_PLANE");
  });
  const request = vi.fn<DockerTransport["request"]>();
  const provider = new DockerSandboxProvider(
    { request },
    {
      image: "sandbox:local",
      network: "local-sandboxes",
      deploymentName: "local",
      controlPlaneUrl: "http://app:8787",
      scmProvider: "gitlab",
      portal: resolveDockerPortalConfig({}),
      sandboxAccessPasswordSecret: "secret",
    }
  );

  beforeEach(() => request.mockReset());

  it("does not expose disabled services or accept injected service ports", async () => {
    request.mockResolvedValueOnce({ status: 201, body: { Id: "container-1" } });
    request.mockResolvedValueOnce({ status: 204, body: null });
    const result = await provider.createSandbox({
      ...config,
      userEnvVars: {
        CODE_SERVER_PASSWORD: "inject",
        CODE_SERVER_PORT: "8787",
        VNC_PASSWORD: "inject",
        NOVNC_PORT: "8787",
        TERMINAL_ENABLED: "true",
        TTYD_PROXY_PORT: "8787",
        EXPECTED_TUNNEL_PORTS: "8787",
      },
    });
    const body = request.mock.calls[0][2] as { Labels: Record<string, string>; Env: string[] };
    expect(body.Labels.openinspect_portal_allowed_ports).toBe("[]");
    expect(body.Env).toContain("TERMINAL_ENABLED=");
    expect(body.Env).toContain("EXPECTED_TUNNEL_PORTS=");
    expect(
      body.Env.some((value) =>
        /^(CODE_SERVER_|NOVNC_PORT=|VNC_PASSWORD=|TTYD_PROXY_PORT=)/.test(value)
      )
    ).toBe(false);
    expect(result).not.toHaveProperty("codeServerUrl");
    expect(result).not.toHaveProperty("vncAccess");
    expect(result).not.toHaveProperty("ttydUrl");
    expect(result).not.toHaveProperty("tunnelUrls");
  });

  it("returns URLs for custom service ports without including them twice as tunnels", async () => {
    request.mockResolvedValueOnce({ status: 201, body: { Id: "container-1" } });
    request.mockResolvedValueOnce({ status: 204, body: null });
    const result = await provider.createSandbox({
      ...config,
      codeServerEnabled: true,
      vncEnabled: true,
      sandboxSettings: {
        codeServerPort: 8888,
        vncPort: 8889,
        terminalEnabled: true,
        terminalPort: 8890,
        tunnelPorts: [8888, 8889, 8890, 5173, 5173, 7681, 5900],
      },
    });
    expect(result.codeServerUrl).toMatch(/^http:\/\/p8888-/);
    expect(result.vncAccess?.url).toMatch(/^http:\/\/p8889-/);
    expect(result.ttydUrl).toMatch(/^http:\/\/p8890-/);
    expect(Object.keys(result.tunnelUrls ?? {})).toEqual(["5173"]);
  });

  it("creates then starts with canonical env, labels and the shared network", async () => {
    request.mockResolvedValueOnce({ status: 201, body: { Id: "container-1" } });
    request.mockResolvedValueOnce({ status: 204, body: null });
    const result = await provider.createSandbox({
      ...config,
      codeServerEnabled: true,
      vncEnabled: true,
      sandboxSettings: { terminalEnabled: true, tunnelPorts: [3000] },
      userEnvVars: {
        CUSTOM: "hello=world",
        CONTROL_PLANE_URL: "https://wrong.example",
        SESSION_CONFIG: "{}",
        IMAGE_BUILD_MODE: "true",
        RESTORED_FROM_SNAPSHOT: "true",
        OI_DEFERRED_START: "true",
        OPENINSPECT_DOCKER_ENABLED: "true",
        CODE_SERVER_PASSWORD: "wrong",
        CODE_SERVER_PORT: "9999",
        VNC_PASSWORD: "wrong",
        NOVNC_PORT: "9998",
        TTYD_PROXY_PORT: "9997",
        TERMINAL_ENABLED: "",
        EXPECTED_TUNNEL_PORTS: "9996",
      },
    });
    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ["POST", "/containers/create?name=openinspect-sandbox-1&platform=linux%2Famd64"],
      ["POST", "/containers/container-1/start"],
    ]);
    const body = request.mock.calls[0][2] as {
      Env: string[];
      HostConfig: unknown;
      Labels: Record<string, string>;
    };
    expect(body).toMatchObject({
      Image: "sandbox:local",
      Labels: {
        openinspect_session_id: "session-1",
        openinspect_expected_sandbox_id: "sandbox-1",
        openinspect_deployment: "local",
      },
      Entrypoint: ["/bin/bash", "/app/docker-launcher.sh"],
      Cmd: [],
      HostConfig: {
        NetworkMode: "local-sandboxes",
        Init: true,
        AutoRemove: false,
        RestartPolicy: { Name: "no" },
      },
    });
    expect(body.HostConfig).not.toHaveProperty("Binds");
    expect(body.HostConfig).not.toHaveProperty("PortBindings");
    const env = Object.fromEntries(
      body.Env.map((entry) => [
        entry.slice(0, entry.indexOf("=")),
        entry.slice(entry.indexOf("=") + 1),
      ])
    );
    expect(env).toMatchObject({
      CONTROL_PLANE_URL: "http://app:8787",
      SANDBOX_ID: "sandbox-1",
      SANDBOX_AUTH_TOKEN: "auth-token",
      CUSTOM: "hello=world",
      REPO_OWNER: "group/subgroup",
      VCS_HOST: "gitlab.com",
      OI_ALLOW_HTTP_CONTROL_PLANE: "true",
      OI_DEFERRED_START: "false",
      IMAGE_BUILD_MODE: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      OPENINSPECT_DOCKER_ENABLED: "false",
      TERMINAL_ENABLED: "true",
      CODE_SERVER_PORT: "8080",
      NOVNC_PORT: "6080",
      TTYD_PROXY_PORT: "7680",
      EXPECTED_TUNNEL_PORTS: "3000",
    });
    expect(env.CODE_SERVER_PASSWORD).toBe(
      await deriveCodeServerPassword(config.sandboxId, "secret")
    );
    expect(env.VNC_PASSWORD).toBe(await deriveVncPassword(config.sandboxId, "secret"));
    const token = body.Labels.openinspect_portal_token;
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(body.Labels.openinspect_portal_allowed_ports).toBe("[8080,7680,6080,3000]");
    expect(body.Labels.openinspect_kind).toBe("session");
    const url = (port: number) => `http://p${port}-${token}.localhost:8790`;
    expect(JSON.parse(env.SESSION_CONFIG)).toMatchObject({
      session_id: "session-1",
      bridge_early_connect: true,
      harness: "opencode",
      branch: "main",
    });
    expect(result).toEqual({
      sandboxId: "sandbox-1",
      providerObjectId: "container-1",
      createdAt: expect.any(Number),
      lifetime: { kind: "none", observedAtMs: expect.any(Number) },
      codeServerUrl: url(8080),
      codeServerPassword: env.CODE_SERVER_PASSWORD,
      ttydUrl: url(7680),
      vncAccess: { url: url(6080), password: env.VNC_PASSWORD },
      tunnelUrls: { "3000": url(3000) },
    });
    request.mockResolvedValueOnce({ status: 200, body: { Config: { Labels: body.Labels } } });
    request.mockResolvedValueOnce({ status: 204, body: null });
    const resumed = await provider.resumeSandbox({
      ...stopConfig,
      sandboxId: config.sandboxId,
      sandboxSettings: { tunnelPorts: [9999] },
    });
    expect(resumed).toMatchObject({
      success: true,
      codeServerUrl: result.codeServerUrl,
      codeServerPassword: result.codeServerPassword,
      ttydUrl: result.ttydUrl,
      vncAccess: result.vncAccess,
      tunnelUrls: result.tunnelUrls,
    });
  });

  it("uses the lifecycle callback URL when no Docker override is configured", async () => {
    const fallback = new DockerSandboxProvider(
      { request },
      {
        image: "local",
        network: "local",
        deploymentName: "local",
        scmProvider: "github",
        portal: resolveDockerPortalConfig({}),
        sandboxAccessPasswordSecret: "secret",
      }
    );
    request.mockResolvedValueOnce({ status: 201, body: { Id: "container-1" } });
    request.mockResolvedValueOnce({ status: 204, body: null });
    await fallback.createSandbox(config);
    expect(request.mock.calls[0][2]).toMatchObject({
      Env: expect.arrayContaining(["CONTROL_PLANE_URL=https://public.example"]),
    });
  });

  it("removes a created container when start fails, retaining the original error", async () => {
    request.mockResolvedValueOnce({ status: 201, body: { Id: "container-1" } });
    request.mockResolvedValueOnce({ status: 500, body: { message: "secret" } });
    request.mockResolvedValueOnce({ status: 204, body: null });
    await expect(provider.createSandbox(config)).rejects.toMatchObject({
      errorType: "transient",
      message: "Docker Engine POST failed (HTTP 500)",
    });
    expect(request).toHaveBeenLastCalledWith(
      "DELETE",
      "/containers/container-1?force=true&v=true",
      undefined,
      undefined
    );
  });

  it("recovers a lost create response by name and matching ownership labels for cleanup", async () => {
    request.mockRejectedValueOnce(new Error("ECONNRESET"));
    request.mockImplementationOnce(async () => ({
      status: 200,
      body: {
        Id: "container-1",
        Config: {
          Labels: (request.mock.calls[0][2] as { Labels: Record<string, string> }).Labels,
        },
      },
    }));
    request.mockResolvedValueOnce({ status: 204, body: null });
    await expect(provider.createSandbox(config)).rejects.toMatchObject({ errorType: "transient" });
    expect(request).toHaveBeenLastCalledWith(
      "DELETE",
      "/containers/container-1?force=true&v=true",
      undefined,
      undefined
    );
  });

  it("does not remove another deployment's container after a lost response", async () => {
    request.mockRejectedValueOnce(new Error("ECONNRESET"));
    request.mockResolvedValueOnce({
      status: 200,
      body: { Id: "other", Config: { Labels: { openinspect_deployment: "other" } } },
    });
    await expect(provider.createSandbox(config)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not remove a previous allocation of the same sandbox after a lost response", async () => {
    request.mockRejectedValueOnce(new Error("ECONNRESET"));
    request.mockImplementationOnce(async () => ({
      status: 200,
      body: {
        Id: "previous-container",
        Config: {
          Labels: {
            ...(request.mock.calls[0][2] as { Labels: Record<string, string> }).Labels,
            openinspect_portal_token: "previous-token",
          },
        },
      },
    }));
    await expect(provider.createSandbox(config)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([404, 409])("does not start or delete after create HTTP %s", async (status) => {
    request.mockResolvedValueOnce({ status, body: {} });
    await expect(provider.createSandbox(config)).rejects.toMatchObject({ errorType: "permanent" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([204, 304])("resumes the same disk with Docker start (HTTP %s)", async (status) => {
    request.mockResolvedValueOnce({
      status: 200,
      body: {
        Config: {
          Labels: {
            openinspect_framework: "open-inspect",
            openinspect_deployment: "local",
            openinspect_session_id: "session-1",
            openinspect_expected_sandbox_id: "sandbox-1",
          },
        },
      },
    });
    request.mockResolvedValueOnce({ status, body: null });
    expect(await provider.resumeSandbox({ ...stopConfig, sandboxId: "sandbox-1" })).toMatchObject({
      success: true,
      providerObjectId: "container-1",
      lifetime: { kind: "none" },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/containers/container-1/start",
      undefined,
      undefined
    );
  });

  it("requests a fresh spawn only when the resumed container is missing", async () => {
    request.mockResolvedValueOnce({ status: 404, body: {} });
    expect(await provider.resumeSandbox({ ...stopConfig, sandboxId: "sandbox-1" })).toMatchObject({
      success: false,
      shouldSpawnFresh: true,
    });
    request.mockResolvedValueOnce({ status: 503, body: {} });
    await expect(
      provider.resumeSandbox({ ...stopConfig, sandboxId: "sandbox-1" })
    ).rejects.toMatchObject({ errorType: "transient" });
  });

  it.each([204, 304])("preserves and verifies a stopped container (HTTP %s)", async (status) => {
    const signal = new AbortController().signal;
    request.mockResolvedValueOnce({ status, body: null });
    request.mockResolvedValueOnce({ status: 200, body: { State: { Status: "exited" } } });
    expect(await provider.stopSandbox({ ...stopConfig, signal })).toEqual({ success: true });
    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ["POST", "/containers/container-1/stop?t=5"],
      ["GET", "/containers/container-1/json"],
    ]);
    expect(request.mock.calls.every((call) => call[3] === signal)).toBe(true);
  });

  it("does not confirm a preserved disk which disappeared or is still running", async () => {
    request.mockResolvedValueOnce({ status: 404, body: {} });
    expect(await provider.stopSandbox(stopConfig)).toMatchObject({ success: false });
    request.mockResolvedValueOnce({ status: 204, body: null });
    request.mockResolvedValueOnce({ status: 200, body: { State: { Status: "running" } } });
    expect(await provider.stopSandbox(stopConfig)).toMatchObject({ success: false });
  });

  it("destroys terminal allocations and treats missing ones as already removed", async () => {
    request.mockResolvedValueOnce({ status: 204, body: null });
    request.mockResolvedValueOnce({ status: 204, body: null });
    expect(await provider.stopSandbox({ ...stopConfig, intent: "destroy" })).toEqual({
      success: true,
    });
    expect(request).toHaveBeenLastCalledWith(
      "DELETE",
      "/containers/container-1?force=true&v=true",
      undefined,
      undefined
    );
    request.mockResolvedValueOnce({ status: 404, body: {} });
    expect(await provider.stopSandbox({ ...stopConfig, intent: "destroy" })).toEqual({
      success: true,
    });
  });

  it("reports socket permissions clearly without disclosing request secrets", async () => {
    request.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "EACCES" }));
    await expect(
      provider.resumeSandbox({ ...stopConfig, sandboxId: "sandbox-1" })
    ).rejects.toMatchObject({
      errorType: "permanent",
      message: expect.stringContaining("socket group permissions"),
    });
  });

  it("declares unsupported features and refuses prebuilt images before allocation", async () => {
    expect(provider.capabilities).toEqual({
      supportsSandboxTimeout: false,
      supportsSnapshots: false,
      supportsRestore: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
    await expect(
      provider.createSandbox({ ...config, prebuiltImageId: "old-image" })
    ).rejects.toThrow("does not support prebuilt");
    expect(request).not.toHaveBeenCalled();
  });
});
