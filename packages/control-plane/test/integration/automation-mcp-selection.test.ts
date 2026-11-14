/**
 * Automation MCP selections through the deployed Worker against real D1 and the session Durable
 * Object: which servers an automation may select, the owner lock on edits, and which runs act as
 * the owner through its personal servers.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { AutomationStore } from "../../src/db/automation-store";
import { PersonalAccessTokenStore } from "../../src/db/personal-access-tokens";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { cleanD1Tables } from "./cleanup";
import { queryDO, seedActiveUser, serviceFetch } from "./helpers";
import { fetchRuns } from "./run-helpers";

const BASE = "https://cp.test";
const OWNER = "77777777777777777777777777777777";
const ADMIN = "99999999999999999999999999999999";
const schedule = { scheduleCron: "0 9 * * *", scheduleTz: "UTC" };

async function issueToken(userId: string, permissions: PermissionId[]): Promise<string> {
  const result = await new PersonalAccessTokenStore(env.DB).issue({
    userId,
    name: "integration",
    permissions,
    expiresAt: Date.now() + 60 * 60 * 1000,
    now: Date.now(),
    requestId: "integration",
  });
  if (result.kind !== "issued") throw new Error("token was not issued");
  return result.token.token;
}

function withToken(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function asUser(userId: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return serviceFetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    as: { userId, role: userId === ADMIN ? "administrator" : "member" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function seedServer(id: string, name: string, authMode = "none") {
  const personal = authMode === "user_oauth";
  await env.DB.prepare(
    `INSERT INTO mcp_servers
       (id, name, type, url, env, repo_scope, enabled, created_at, updated_at,
        auth_mode, managed_routing, oauth_profile)
     VALUES (?, ?, 'remote', ?, '{}', NULL, 1, 1, 1, ?, ?, ?)`
  )
    .bind(
      id,
      name,
      `https://${name}.example.com/mcp`,
      authMode,
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

/** An automation saved the way rows predating MCP selection were: without the column. */
async function saveLegacyAutomation(id: string, userId: string) {
  await env.DB.prepare(
    `INSERT INTO automations
       (id, name, instructions, schedule_cron, model, created_by, user_id, created_at, updated_at)
     VALUES (?, ?, 'Run tests', '0 9 * * *', 'anthropic/claude-sonnet-4-6', ?, ?, 1, 1)`
  )
    .bind(id, id, userId, userId)
    .run();
}

async function saveAutomation(id: string, userId: string, mcpServerIds: string[]) {
  await saveLegacyAutomation(id, userId);
  await env.DB.prepare("UPDATE automations SET mcp_server_ids = ? WHERE id = ?")
    .bind(JSON.stringify(mcpServerIds), id)
    .run();
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ code });
}

/** The first prompt of the automation's only run, as its session queued it. */
async function firstPrompt(automationId: string) {
  const [run] = await fetchRuns(automationId);
  expect(run?.session_id).toEqual(expect.any(String));
  const stub = env.SESSION.get(env.SESSION.idFromName(run!.session_id!));
  const [message] = await queryDO<{ mcp_eligible: number; admitted_canonical_user_id: string }>(
    stub,
    "SELECT mcp_eligible, admitted_canonical_user_id FROM messages WHERE source = 'automation'"
  );
  const [session] = await queryDO<{ mcp_selection: string | null }>(
    stub,
    "SELECT mcp_selection FROM session"
  );
  return { message, selection: JSON.parse(session!.mcp_selection ?? "null") };
}

beforeEach(async () => {
  await cleanD1Tables();
  for (const userId of [OWNER, ADMIN]) await seedActiveUser(userId);
  await env.DB.prepare(
    "UPDATE user_role_assignments SET role_id = 'role_builtin_administrator' WHERE user_id = ?"
  )
    .bind(ADMIN)
    .run();
  await seedServer("srv-docs", "docs");
  await seedServer("srv-tracker", "tracker", "user_oauth");
});
afterEach(cleanD1Tables);

describe("automation MCP selection on save", () => {
  it("gives automations that predate selection, and new ones, no MCP server", async () => {
    await saveLegacyAutomation("auto-legacy", OWNER);
    expect(await new AutomationStore(env.DB).getById("auto-legacy")).toMatchObject({
      mcp_server_ids: "[]",
    });
    const legacy = await asUser(OWNER, "/automations/auto-legacy");
    await expect(legacy.json()).resolves.toMatchObject({ automation: { mcpServerIds: [] } });

    const created = await asUser(OWNER, "/automations", {
      method: "POST",
      body: { name: "New", instructions: "Report", ...schedule },
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ automation: { mcpServerIds: [] } });
  });

  it("stores the owner's selection, personal servers included", async () => {
    const created = await asUser(OWNER, "/automations", {
      method: "POST",
      body: {
        name: "Report",
        instructions: "Report",
        ...schedule,
        mcpServerIds: ["srv-tracker", "srv-docs"],
      },
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      automation: { mcpServerIds: ["srv-tracker", "srv-docs"] },
    });
  });

  it("refuses unknown servers, and personal servers for event triggers and team automations", async () => {
    await expectRefusal(
      await asUser(OWNER, "/automations", {
        method: "POST",
        body: { name: "R", instructions: "R", ...schedule, mcpServerIds: ["srv-missing"] },
      }),
      400,
      "invalid_mcp_servers"
    );
    await expectRefusal(
      await asUser(OWNER, "/automations", {
        method: "POST",
        body: {
          name: "Hook",
          instructions: "R",
          triggerType: "webhook",
          mcpServerIds: ["srv-tracker"],
        },
      }),
      400,
      "event_trigger_personal_mcp"
    );
    // A workspace server is fine on an event trigger.
    expect(
      (
        await asUser(OWNER, "/automations", {
          method: "POST",
          body: {
            name: "Hook",
            instructions: "R",
            triggerType: "webhook",
            mcpServerIds: ["srv-docs"],
          },
        })
      ).status
    ).toBe(201);

    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_data', 'data', 'Data', 1, 1)"
    ).run();
    await new TeamMembershipStore(env.DB).add("team_data", OWNER);
    await expectRefusal(
      await asUser(OWNER, "/automations", {
        method: "POST",
        body: {
          teamId: "team_data",
          name: "Team",
          instructions: "R",
          ...schedule,
          mcpServerIds: ["srv-tracker"],
        },
      }),
      400,
      "team_automation_personal_mcp"
    );
  });

  it("lets a token select personal servers only with the mcp_connections.use grant", async () => {
    const body = { name: "R", instructions: "R", ...schedule, mcpServerIds: ["srv-tracker"] };
    const base: PermissionId[] = ["automations.create", "sessions.create"];
    await expectRefusal(
      await withToken(await issueToken(OWNER, base), "/automations", { method: "POST", body }),
      403,
      "personal_mcp_permission_required"
    );
    expect(
      (
        await withToken(await issueToken(OWNER, [...base, "mcp_connections.use"]), "/automations", {
          method: "POST",
          body,
        })
      ).status
    ).toBe(201);
  });
});

describe("the owner lock", () => {
  it("refuses anyone but the owner while personal servers are selected; pause and delete stay open", async () => {
    await saveAutomation("auto-locked", OWNER, ["srv-tracker"]);
    await expectRefusal(
      await asUser(ADMIN, "/automations/auto-locked", { method: "PUT", body: { name: "Mine" } }),
      403,
      "automation_owner_locked"
    );
    await expectRefusal(
      await asUser(ADMIN, "/automations/auto-locked", {
        method: "PUT",
        body: { mcpServerIds: [] },
      }),
      403,
      "automation_owner_locked"
    );
    expect(await new AutomationStore(env.DB).getById("auto-locked")).toMatchObject({
      name: "auto-locked",
      mcp_server_ids: JSON.stringify(["srv-tracker"]),
    });

    expect((await asUser(ADMIN, "/automations/auto-locked/pause", { method: "POST" })).status).toBe(
      200
    );
    expect(
      (
        await asUser(OWNER, "/automations/auto-locked", {
          method: "PUT",
          body: { name: "Renamed", mcpServerIds: ["srv-tracker", "srv-docs"] },
        })
      ).status
    ).toBe(200);
    expect((await asUser(ADMIN, "/automations/auto-locked", { method: "DELETE" })).status).toBe(
      200
    );
  });

  it("lets others edit an automation without personal servers, but not add one", async () => {
    await saveAutomation("auto-open", OWNER, ["srv-docs"]);
    expect(
      (await asUser(ADMIN, "/automations/auto-open", { method: "PUT", body: { name: "Admin" } }))
        .status
    ).toBe(200);
    await expectRefusal(
      await asUser(ADMIN, "/automations/auto-open", {
        method: "PUT",
        body: { mcpServerIds: ["srv-docs", "srv-tracker"] },
      }),
      403,
      "personal_mcp_owner_only"
    );
  });

  it("refuses to change the executor while personal servers are selected", async () => {
    await saveAutomation("auto-handoff", OWNER, ["srv-tracker"]);
    await expectRefusal(
      await asUser(ADMIN, "/automations/auto-handoff", {
        method: "PATCH",
        body: { userId: ADMIN },
      }),
      403,
      "automation_owner_locked"
    );
    expect((await new AutomationStore(env.DB).getById("auto-handoff"))?.user_id).toBe(OWNER);

    await saveAutomation("auto-plain", OWNER, ["srv-docs"]);
    expect(
      (await asUser(ADMIN, "/automations/auto-plain", { method: "PATCH", body: { userId: ADMIN } }))
        .status
    ).toBe(200);
  });

  it("does not lock on a personal server that has since been deleted", async () => {
    await saveAutomation("auto-dangling", OWNER, ["srv-gone"]);
    expect(
      (
        await asUser(ADMIN, "/automations/auto-dangling", {
          method: "PUT",
          body: { name: "Admin", mcpServerIds: ["srv-gone"] },
        })
      ).status
    ).toBe(200);
  });
});

describe("runs that act as the owner", () => {
  const trigger: PermissionId[] = [
    "automations.read",
    "automations.trigger.own",
    "sessions.create",
  ];

  it("pins the selection and lets the owner's own firing use personal servers", async () => {
    await saveAutomation("auto-run", OWNER, ["srv-tracker", "srv-docs"]);
    const token = await issueToken(OWNER, [...trigger, "mcp_connections.use"]);
    expect(
      (await withToken(token, "/automations/auto-run/trigger", { method: "POST" })).status
    ).toBe(201);
    const { message, selection } = await firstPrompt("auto-run");
    expect(message).toEqual({ mcp_eligible: 1, admitted_canonical_user_id: OWNER });
    expect(selection).toEqual([
      { id: "srv-tracker", name: "tracker" },
      { id: "srv-docs", name: "docs" },
    ]);
  });

  it("runs without personal servers for a token lacking the grant", async () => {
    await saveAutomation("auto-run", OWNER, ["srv-tracker"]);
    const token = await issueToken(OWNER, trigger);
    expect(
      (await withToken(token, "/automations/auto-run/trigger", { method: "POST" })).status
    ).toBe(201);
    expect((await firstPrompt("auto-run")).message?.mcp_eligible).toBe(0);
  });

  it("runs without personal servers when someone else triggers it", async () => {
    await saveAutomation("auto-run", OWNER, ["srv-tracker"]);
    expect((await asUser(ADMIN, "/automations/auto-run/trigger", { method: "POST" })).status).toBe(
      201
    );
    expect((await firstPrompt("auto-run")).message?.mcp_eligible).toBe(0);
  });

  it("is not eligible when the selection has no personal server", async () => {
    await saveAutomation("auto-run", OWNER, ["srv-docs"]);
    expect((await asUser(OWNER, "/automations/auto-run/trigger", { method: "POST" })).status).toBe(
      201
    );
    const { message, selection } = await firstPrompt("auto-run");
    expect(message?.mcp_eligible).toBe(0);
    expect(selection).toEqual([{ id: "srv-docs", name: "docs" }]);
  });
});
