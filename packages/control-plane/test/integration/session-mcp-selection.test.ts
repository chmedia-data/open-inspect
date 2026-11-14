/**
 * Per-session MCP selection through the deployed Worker against real D1 and the session Durable
 * Object: creation validates and pins the selection, the read route reports it, and the launch
 * lookup applies it.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { SessionMcpSelectionView } from "@open-inspect/shared/types/integrations";
import { McpServerStore } from "../../src/db/mcp-servers";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { SessionMcpSelectionStore } from "../../src/db/session-mcp-selections";
import { cleanD1Tables } from "./cleanup";
import { queryDO, seedActiveUser, serviceFetch } from "./helpers";

const BASE = "https://cp.test";
const OWNER = "77777777777777777777777777777777";

async function issueToken(permissions: PermissionId[]): Promise<string> {
  const result = await new PersonalAccessTokenStore(env.DB).issue({
    userId: OWNER,
    name: "integration",
    permissions,
    expiresAt: Date.now() + 60 * 60 * 1000,
    now: Date.now(),
    requestId: "integration",
  });
  if (result.kind !== "issued") throw new Error("token was not issued");
  return result.token.token;
}

function createSession(token: string, body: Record<string, unknown>) {
  return SELF.fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "MCP", model: "anthropic/claude-haiku-4-5", ...body }),
  });
}

async function seedServer(
  id: string,
  name: string,
  options: { authMode?: string; enabled?: boolean; repoScope?: string[] } = {}
) {
  const personal = options.authMode === "user_oauth";
  await env.DB.prepare(
    `INSERT INTO mcp_servers
       (id, name, type, url, env, repo_scope, enabled, created_at, updated_at,
        auth_mode, managed_routing, oauth_profile)
     VALUES (?, ?, 'remote', ?, '{}', ?, ?, 1, 1, ?, ?, ?)`
  )
    .bind(
      id,
      name,
      `https://${name}.example.com/mcp`,
      options.repoScope ? JSON.stringify(options.repoScope) : null,
      options.enabled === false ? 0 : 1,
      options.authMode ?? "none",
      personal ? 1 : 0,
      personal
        ? JSON.stringify({
            issuer: "https://auth.example.com",
            resource: `https://${name}.example.com/mcp`,
          })
        : null
    )
    .run();
}

async function sessionMcpRow(sessionId: string) {
  const [row] = await queryDO<{ mcp_selection: string | null }>(
    env.SESSION.get(env.SESSION.idFromName(sessionId)),
    "SELECT mcp_selection FROM session"
  );
  return row?.mcp_selection ?? null;
}

async function view(sessionId: string): Promise<SessionMcpSelectionView> {
  const response = await serviceFetch(`https://test.local/sessions/${sessionId}/mcp-servers`, {
    as: { userId: OWNER, role: "member" },
  });
  expect(response.status).toBe(200);
  return response.json<SessionMcpSelectionView>();
}

beforeEach(async () => {
  await cleanD1Tables();
  await seedActiveUser(OWNER);
  await seedServer("srv-docs", "docs");
  await seedServer("srv-wiki", "wiki");
  await seedServer("srv-off", "off", { enabled: false });
  await seedServer("srv-scoped", "scoped", { repoScope: ["other/repo"] });
  await seedServer("srv-tracker", "tracker", { authMode: "user_oauth" });
});
afterEach(cleanD1Tables);

describe("creating a session with an MCP selection", () => {
  it("pins the selected servers in D1 and the Durable Object, and reports them", async () => {
    const token = await issueToken(["sessions.create"]);
    const response = await createSession(token, {
      mcpSelection: { mode: "selected", serverIds: ["srv-docs"] },
    });
    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();

    expect(await new SessionMcpSelectionStore(env.DB).getPin(sessionId)).toEqual({
      mode: "selected",
      servers: [{ id: "srv-docs", name: "docs" }],
    });
    expect(JSON.parse((await sessionMcpRow(sessionId))!)).toEqual([
      { id: "srv-docs", name: "docs" },
    ]);
    expect(await view(sessionId)).toEqual({
      mode: "selected",
      servers: [{ id: "srv-docs", name: "docs", authMode: "none", available: true }],
    });

    // A server disabled or deleted after creation stays listed, marked unavailable.
    await env.DB.prepare("DELETE FROM mcp_servers WHERE id = 'srv-docs'").run();
    expect((await view(sessionId)).servers).toEqual([
      { id: "srv-docs", name: "docs", authMode: null, available: false },
    ]);
  });

  it("keeps today's behaviour when no selection is sent", async () => {
    const token = await issueToken(["sessions.create"]);
    const response = await createSession(token, {});
    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    expect(await new SessionMcpSelectionStore(env.DB).getPin(sessionId)).toEqual({ mode: "all" });
    expect(await sessionMcpRow(sessionId)).toBeNull();
    const all = await view(sessionId);
    expect(all.mode).toBe("all");
    // Enabled, unscoped servers only: the session has no repository.
    expect(all.servers.map((server) => server.name)).toEqual(["docs", "tracker", "wiki"]);
  });

  it("launches no server for an empty selection", async () => {
    const token = await issueToken(["sessions.create"]);
    const response = await createSession(token, {
      mcpSelection: { mode: "selected", serverIds: [] },
    });
    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    expect(await sessionMcpRow(sessionId)).toBe("[]");
    const registry = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
    expect(await registry.getForLaunch([], [])).toEqual([]);
    expect(await registry.getForLaunch([], null)).toHaveLength(3);
  });

  it("refuses unknown, disabled and out-of-scope servers, naming them", async () => {
    const token = await issueToken(["sessions.create"]);
    const response = await createSession(token, {
      mcpSelection: {
        mode: "selected",
        serverIds: ["srv-docs", "srv-missing", "srv-off", "srv-scoped"],
      },
    });
    expect(response.status).toBe(400);
    const body = await response.json<{ code: string; error: string }>();
    expect(body.code).toBe("invalid_mcp_servers");
    expect(body.error).toContain("srv-missing, srv-off, srv-scoped");
    expect(body.error).not.toContain("srv-docs");
  });

  it("selects a personal server only when the token holds mcp_connections.use", async () => {
    const selection = { mode: "selected", serverIds: ["srv-tracker", "srv-docs"] };
    const refused = await createSession(await issueToken(["sessions.create"]), {
      mcpSelection: selection,
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      code: "personal_mcp_permission_required",
    });

    const granted = await createSession(
      await issueToken(["sessions.create", "mcp_connections.use"]),
      { mcpSelection: selection }
    );
    expect(granted.status).toBe(201);
  });
});

describe("listing MCP servers with a token", () => {
  function get(token: string, path: string) {
    return SELF.fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }

  it("lists servers with mcp_servers.read and is refused without it", async () => {
    const reader = await issueToken(["mcp_servers.read"]);
    const listed = await get(reader, "/mcp-servers");
    expect(listed.status).toBe(200);
    const servers = await listed.json<{ id: string }[]>();
    expect(servers.map((server) => server.id).sort()).toEqual([
      "srv-docs",
      "srv-off",
      "srv-scoped",
      "srv-tracker",
      "srv-wiki",
    ]);

    const unrelated = await issueToken(["sessions.read"]);
    expect((await get(unrelated, "/mcp-servers")).status).toBe(403);
  });

  it("reads its owner's connection status only when granted mcp_connections.use", async () => {
    const granted = await issueToken(["mcp_connections.use"]);
    const status = await get(granted, "/mcp-connections/status");
    expect(status.status).toBe(200);
    const { connections } = await status.json<{
      connections: { serverId: string; status: string }[];
    }>();
    expect(connections).toEqual([
      expect.objectContaining({ serverId: "srv-tracker", status: "not_connected" }),
    ]);

    const reader = await issueToken(["mcp_servers.read"]);
    expect((await get(reader, "/mcp-connections/status")).status).toBe(403);
    // The browser list, which viewers rely on, still refuses tokens.
    expect((await get(granted, "/mcp-connections")).status).toBe(403);
  });
});
