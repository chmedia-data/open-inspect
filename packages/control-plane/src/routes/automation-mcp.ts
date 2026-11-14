/**
 * MCP server selection rules for automations: which servers an automation may select, and who may
 * edit one whose selection acts as its owner (docs/proposals/session-mcp-selection.md).
 */

import type { AutomationTriggerType } from "@open-inspect/shared/triggers";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import { parseAutomationMcpServerIds, type AutomationRow } from "../db/automation-store";
import { EnvironmentStore } from "../db/environments";
import { McpServerStore } from "../db/mcp-servers";
import type { SqlDatabase } from "../db/sql-database";
import {
  McpSelectionError,
  PERSONAL_MCP_PERMISSION,
  isUserOAuthServer,
  validateMcpServerIds,
} from "../mcp/selection";
import type { Env } from "../types";
import { json, type RequestContext } from "./shared";

type Repository = { repoOwner: string; repoName: string };

/**
 * Whether the request comes from this user acting as themselves: their browser session or their
 * own token. A bot acting for them does not count. Holding `mcp_connections.use` is checked
 * separately, against the request's permissions (a token's grant included).
 */
export function actsAsUser(ctx: RequestContext, userId: string | null): boolean {
  if (!userId) return false;
  const principal = ctx.principal;
  return (
    (principal?.kind === "user" || principal?.kind === "personal-access-token") &&
    principal.userId === userId
  );
}

/** Every repository an automation's runs target: its repositories and its environments' members. */
export async function automationTargetRepositories(
  db: SqlDatabase,
  repositories: readonly Repository[],
  environmentIds: readonly string[]
): Promise<Repository[]> {
  const store = new EnvironmentStore(db);
  const members = await Promise.all(
    environmentIds.map((id) => store.getRepositoriesForEnvironment(id))
  );
  return [
    ...repositories,
    ...members.flat().map((member) => ({
      repoOwner: member.repo_owner,
      repoName: member.repo_name,
    })),
  ];
}

function registry(db: SqlDatabase, env: Env): McpServerStore {
  return new McpServerStore(db, env.REPO_SECRETS_ENCRYPTION_KEY ?? "");
}

/** Servers by id, for the stored ids that still name one. */
async function serversById(
  db: SqlDatabase,
  env: Env,
  ids: readonly string[]
): Promise<Map<string, McpServerMetadata>> {
  if (ids.length === 0) return new Map();
  const wanted = new Set(ids);
  return new Map(
    (await registry(db, env).list())
      .filter((server) => wanted.has(server.id))
      .map((server) => [server.id, server])
  );
}

export interface AutomationMcpSelectionInput {
  /** The full selection the automation will have after this write. */
  serverIds: readonly string[];
  /** Ids already stored; only newly added ones must be enabled and in scope. */
  storedIds?: readonly string[];
  repositories: readonly Repository[];
  triggerType: AutomationTriggerType;
  ownerTeamId: string | null;
  /** The automation's owner: the creator on create, `automation.user_id` on update. */
  ownerUserId: string | null;
}

/**
 * Check an automation's MCP selection on save. Every newly added id must be an enabled server in
 * the automation's scope (ids kept from before are not re-checked: one disabled or deleted since
 * is dropped at launch with a warning). Personal servers act as the owner, so they need all of:
 * a personal automation, a schedule trigger, the owner acting as themselves, and the owner's
 * `mcp_connections.use` within this request's permissions. Returns the refusal, or null.
 */
export async function validateAutomationMcpSelection(
  ctx: RequestContext,
  env: Env,
  input: AutomationMcpSelectionInput
): Promise<Response | null> {
  const stored = new Set(input.storedIds ?? []);
  const added = input.serverIds.filter((id) => !stored.has(id));
  try {
    // Personal rules are decided below with automation-specific reasons.
    await validateMcpServerIds(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY, {
      serverIds: added,
      repositories: input.repositories,
      mayUsePersonal: true,
    });
  } catch (e) {
    if (e instanceof McpSelectionError) return json({ error: e.message, code: e.code }, e.status);
    throw e;
  }
  const servers = await serversById(ctx.db, env, input.serverIds);
  const personal = input.serverIds
    .map((id) => servers.get(id))
    .filter((server): server is McpServerMetadata => !!server && isUserOAuthServer(server));
  if (personal.length === 0) return null;
  const names = personal.map((server) => server.name).join(", ");
  if (input.ownerTeamId !== null) {
    return json(
      {
        error: `Team automations cannot select personal MCP servers (${names}); use a server with shared service credentials instead`,
        code: "team_automation_personal_mcp",
      },
      400
    );
  }
  if (input.triggerType !== "schedule") {
    return json(
      {
        error: `Personal MCP servers (${names}) can only be selected for scheduled automations, because event-triggered runs carry text from outside the team`,
        code: "event_trigger_personal_mcp",
      },
      400
    );
  }
  if (!actsAsUser(ctx, input.ownerUserId)) {
    return json(
      {
        error: `Only the automation's owner, signed in as themselves, can select personal MCP servers (${names})`,
        code: "personal_mcp_owner_only",
      },
      403
    );
  }
  if (!(ctx.authorization?.permissions.includes(PERSONAL_MCP_PERMISSION) ?? false)) {
    return json(
      {
        error: `Selecting personal MCP servers (${names}) requires the ${PERSONAL_MCP_PERMISSION} permission`,
        code: "personal_mcp_permission_required",
      },
      403
    );
  }
  return null;
}

/**
 * The owner lock: while an automation's stored selection names a personal server, its runs act as
 * the owner at external services, so only the owner acting as themselves may change it. Anyone
 * else, administrators included, may still pause, resume or delete it. Returns the refusal, or
 * null when this caller may edit.
 */
export async function automationOwnerLock(
  ctx: RequestContext,
  env: Env,
  automation: AutomationRow
): Promise<Response | null> {
  // The owner may always edit: keeping personal servers then still needs their permission.
  if (actsAsUser(ctx, automation.user_id)) return null;
  const storedIds = parseAutomationMcpServerIds(automation);
  const servers = await serversById(ctx.db, env, storedIds);
  const personal = storedIds
    .map((id) => servers.get(id))
    .filter((server): server is McpServerMetadata => !!server && isUserOAuthServer(server));
  if (personal.length === 0) return null;
  return json(
    {
      error: `This automation uses personal MCP servers (${personal
        .map((server) => server.name)
        .join(
          ", "
        )}) that act as its owner, so only its owner can edit it. You can still pause or delete it.`,
      code: "automation_owner_locked",
    },
    403
  );
}
