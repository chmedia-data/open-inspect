import { describe, expect, it } from "vitest";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import type { McpConnectionStore } from "../db/mcp-connections";
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
  const store = {
    getClient: async () => null,
    saveClient: async () => {},
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
      return Response.json({
        client_id: "client",
        token_endpoint_auth_method: "none",
        redirect_uris: [REDIRECT],
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { service: new McpOAuthService(store, fetcher), requested };
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
    await expect(service.client(server, REDIRECT)).resolves.toMatchObject({ client_id: "client" });
    expect(requested.slice(0, 2)).toEqual([`${ROOT_PATH}/v4/mcp`, ROOT_PATH]);
  });

  it("fails when neither location publishes metadata", async () => {
    const { service } = setup({});
    await expect(service.client(server, REDIRECT)).rejects.toMatchObject({
      code: "mcp_reconnect_required",
    });
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

describe("McpOAuthService scopes and pre-registered clients", () => {
  function scoped(options: {
    scopes?: unknown;
    registration?: boolean;
    stored?: Record<string, unknown> | null;
  }) {
    const requested: string[] = [];
    const saved: Record<string, unknown>[] = [];
    const store = {
      getClient: async () => options.stored ?? null,
      saveClient: async (client: Record<string, unknown>) => {
        saved.push(client);
      },
      begin: async () => {},
    } as unknown as McpConnectionStore;
    const fetcher = async (request: Request) => {
      const url = new URL(request.url);
      requested.push(url.pathname);
      if (url.pathname.startsWith(ROOT_PATH)) {
        return Response.json({
          resource: RESOURCE,
          authorization_servers: [ORIGIN],
          ...(options.scopes === undefined ? {} : { scopes_supported: options.scopes }),
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: ORIGIN,
          authorization_endpoint: `${ORIGIN}/authorize`,
          token_endpoint: `${ORIGIN}/token`,
          ...(options.registration === false
            ? {}
            : { registration_endpoint: `${ORIGIN}/register` }),
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register") {
        return Response.json({
          client_id: "registered",
          token_endpoint_auth_method: "none",
          redirect_uris: [REDIRECT],
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    return { service: new McpOAuthService(store, fetcher), requested, saved };
  }
  const preregistered = {
    ...server,
    oauth: { issuer: ORIGIN, resource: RESOURCE, clientId: "fixed-client" },
  } as unknown as McpServerMetadata;

  it("requests the scopes the protected resource publishes", async () => {
    const { service, saved } = scoped({ scopes: ["session:role:READER", "refresh_token"] });
    const url = new URL(await service.start("owner", "browser", server, REDIRECT));
    expect(url.searchParams.get("scope")).toBe("session:role:READER refresh_token");
    expect(saved[0]).toMatchObject({ scope: "session:role:READER refresh_token" });
  });

  it("sends no scope when the resource publishes none", async () => {
    const { service, saved } = scoped({});
    const url = new URL(await service.start("owner", "browser", server, REDIRECT));
    expect(url.searchParams.has("scope")).toBe(false);
    expect(saved[0]).toMatchObject({ scope: "" });
  });

  it("uses a pre-registered client without a registration endpoint and never registers", async () => {
    const { service, requested } = scoped({ registration: false, scopes: ["session:role:READER"] });
    const url = new URL(await service.start("owner", "browser", preregistered, REDIRECT));
    expect(url.searchParams.get("client_id")).toBe("fixed-client");
    expect(url.searchParams.get("scope")).toBe("session:role:READER");
    expect(requested).not.toContain("/register");
  });

  it("prefers the pre-registered client even where registration is offered", async () => {
    const { service, requested } = scoped({});
    await expect(service.client(preregistered, REDIRECT)).resolves.toMatchObject({
      client_id: "fixed-client",
    });
    expect(requested).not.toContain("/register");
  });

  it("refuses a server with neither a registration endpoint nor a pre-registered client", async () => {
    const { service } = scoped({ registration: false });
    await expect(service.client(server, REDIRECT)).rejects.toMatchObject({
      code: "mcp_unsupported",
    });
  });

  it("refuses a published scope that is not a valid scope token", async () => {
    for (const scopes of [["role reader"], ['quote"d'], ["back\\slash"], [""]]) {
      const { service } = scoped({ scopes });
      await expect(service.client(server, REDIRECT)).rejects.toBeDefined();
    }
  });

  it("resolves again a stored client from before scopes were recorded", async () => {
    const stored = {
      server_id: "srv",
      auth_revision: 1,
      issuer: ORIGIN,
      resource: RESOURCE,
      client_id: "old",
      redirect_uri: REDIRECT,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      scope: null,
    };
    const { service, requested } = scoped({ stored, scopes: ["session:role:READER"] });
    await expect(service.client(server, REDIRECT)).resolves.toMatchObject({
      scope: "session:role:READER",
    });
    expect(requested.some((path) => path.startsWith(ROOT_PATH))).toBe(true);

    const current = scoped({ stored: { ...stored, scope: "" } });
    await expect(current.service.client(server, REDIRECT)).resolves.toMatchObject({
      client_id: "old",
    });
    expect(current.requested).toEqual([]);
  });
});
