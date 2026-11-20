import { describe, expect, it } from "vitest";
import {
  MCP_OAUTH_LOOPBACK_REDIRECT_URI,
  type McpServerMetadata,
} from "@open-inspect/shared/types/integrations";
import type { McpConnectionStore, McpOAuthClient } from "../db/mcp-connections";
import { McpOAuthService } from "./oauth";

const ORIGIN = "https://api.example.com";
const RESOURCE = `${ORIGIN}/v4/mcp`;
const ROOT_PATH = "/.well-known/oauth-protected-resource";
const REDIRECT = "https://app.example.com/callback";

const server = {
  id: "srv",
  url: RESOURCE,
  enabled: true,
  authMode: "user_oauth",
  managedRouting: true,
  authRevision: 1,
  oauth: { issuer: ORIGIN, resource: RESOURCE },
} as unknown as McpServerMetadata;

function setup(protectedPaths: Record<string, number | undefined>) {
  const requested: string[] = [];
  const registered: string[][] = [];
  let saved: McpOAuthClient | null = null;
  const store = {
    getClient: async () => saved,
    saveClient: async (client: McpOAuthClient) => {
      saved = client;
    },
    begin: async () => {},
  } as unknown as McpConnectionStore;
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    requested.push(url.pathname);
    if (url.pathname.startsWith(ROOT_PATH)) {
      const status = protectedPaths[url.pathname];
      if (status === undefined) return new Response("not found", { status: 404 });
      if (status !== 200) return new Response("error", { status });
      return Response.json({ resource: RESOURCE, authorization_servers: [ORIGIN] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register") {
      const { redirect_uris } = (await request.json()) as { redirect_uris: string[] };
      registered.push(redirect_uris);
      return Response.json({
        client_id: `client-${registered.length}`,
        token_endpoint_auth_method: "none",
        redirect_uris,
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { service: new McpOAuthService(store, fetcher), requested, registered };
}

describe("McpOAuthService protected resource discovery", () => {
  it("uses the path-inserted well-known URL when present", async () => {
    const { service, requested } = setup({ [`${ROOT_PATH}/v4/mcp`]: 200 });
    await service.client(server, REDIRECT);
    expect(requested).toContain(`${ROOT_PATH}/v4/mcp`);
    expect(requested).not.toContain(ROOT_PATH);
  });

  it("falls back to the origin-root well-known URL", async () => {
    const { service, requested } = setup({ [ROOT_PATH]: 200 });
    await expect(service.client(server, REDIRECT)).resolves.toMatchObject({ client_id: "client-1" });
    expect(requested.slice(0, 2)).toEqual([`${ROOT_PATH}/v4/mcp`, ROOT_PATH]);
  });

  it("falls back to the same-origin issuer when both locations answer 404", async () => {
    const { service, requested, registered } = setup({});
    await expect(service.client(server, REDIRECT)).resolves.toMatchObject({
      issuer: ORIGIN,
      token_endpoint: `${ORIGIN}/token`,
    });
    expect(requested).toEqual([
      `${ROOT_PATH}/v4/mcp`,
      ROOT_PATH,
      "/.well-known/oauth-authorization-server",
      "/register",
    ]);
    expect(registered).toEqual([[REDIRECT]]);
  });

  it.each([
    ["the path-inserted probe", { [`${ROOT_PATH}/v4/mcp`]: 500 }],
    ["the origin-root probe", { [ROOT_PATH]: 503 }],
    ["both probes", { [`${ROOT_PATH}/v4/mcp`]: 401, [ROOT_PATH]: 403 }],
  ])("does not fall back after a non-404 failure on %s", async (_label, paths) => {
    const { service, requested } = setup(paths);
    await expect(service.client(server, REDIRECT)).rejects.toMatchObject({
      code: "mcp_reconnect_required",
    });
    expect(requested).not.toContain("/.well-known/oauth-authorization-server");
  });

  it("refuses the fallback for an issuer on another origin", async () => {
    const { service, requested } = setup({});
    const crossOrigin = {
      ...server,
      oauth: { issuer: "https://auth.example.com", resource: RESOURCE },
    } as unknown as McpServerMetadata;
    await expect(service.client(crossOrigin, REDIRECT)).rejects.toMatchObject({
      code: "mcp_denied",
    });
    expect(requested).toEqual([`${ROOT_PATH}/v4/mcp`, ROOT_PATH]);
  });

  it("refuses the fallback when the metadata names a different issuer", async () => {
    const { service, registered } = setup({});
    const mismatched = {
      ...server,
      oauth: { issuer: `${ORIGIN}/`, resource: RESOURCE },
    } as unknown as McpServerMetadata;
    await expect(service.client(mismatched, REDIRECT)).rejects.toMatchObject({
      code: "mcp_denied",
    });
    expect(registered).toEqual([]);
  });

  it("still rejects root metadata naming a different resource", async () => {
    const { service } = setup({ [ROOT_PATH]: 200 });
    const other = {
      ...server,
      url: `${ORIGIN}/other`,
      oauth: { issuer: ORIGIN, resource: `${ORIGIN}/other` },
    } as unknown as McpServerMetadata;
    await expect(service.client(other, REDIRECT)).rejects.toMatchObject({ code: "mcp_denied" });
  });
});

describe("McpOAuthService loopback redirect", () => {
  const loopbackServer = {
    ...server,
    oauth: { issuer: ORIGIN, resource: RESOURCE, redirect: "loopback" },
  } as unknown as McpServerMetadata;

  it("registers and authorizes with the fixed loopback redirect when the server opts in", async () => {
    const { service, registered } = setup({ [ROOT_PATH]: 200 });
    const url = new URL(
      await service.start("owner", "browser", loopbackServer, MCP_OAUTH_LOOPBACK_REDIRECT_URI)
    );
    expect(registered).toEqual([[MCP_OAUTH_LOOPBACK_REDIRECT_URI]]);
    expect(url.searchParams.get("redirect_uri")).toBe(MCP_OAUTH_LOOPBACK_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it.each([
    ["loopback without the opt-in", server, MCP_OAUTH_LOOPBACK_REDIRECT_URI],
    ["plain http on a non-loopback host", server, "http://app.example.com/callback"],
    ["another loopback URI", loopbackServer, "http://127.0.0.1:1/callback"],
    ["the web callback when opted into loopback", loopbackServer, REDIRECT],
  ])("rejects %s before any network call", async (_label, target, redirect) => {
    const { service, requested } = setup({ [ROOT_PATH]: 200 });
    await expect(service.client(target, redirect)).rejects.toMatchObject({
      code: "mcp_unsupported",
    });
    expect(requested).toEqual([]);
  });

  it("re-registers when the redirect mode changes without an auth revision bump", async () => {
    const { service, registered } = setup({ [ROOT_PATH]: 200 });
    const web = await service.client(server, REDIRECT);
    expect((await service.client(server, REDIRECT)).client_id).toBe(web.client_id);
    const loopback = await service.client(loopbackServer, MCP_OAUTH_LOOPBACK_REDIRECT_URI);
    expect(loopback.client_id).not.toBe(web.client_id);
    expect(loopback.redirect_uri).toBe(MCP_OAUTH_LOOPBACK_REDIRECT_URI);
    expect(registered).toEqual([[REDIRECT], [MCP_OAUTH_LOOPBACK_REDIRECT_URI]]);
  });
});
