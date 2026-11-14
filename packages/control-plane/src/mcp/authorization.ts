import { checkSessionAccess } from "@open-inspect/shared";
import { AuthorizationService } from "../authorization/service";
import {
  legacyPermissionForAction,
  parseTeamsEnforcementMode,
  resolverDecides,
} from "../authorization/teams-enforcement";
import { SessionIndexStore } from "../db/session-index";
import { TeamMembershipStore } from "../db/team-memberships";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { McpError } from "./errors";
import { PERSONAL_MCP_PERMISSION } from "./selection";

/**
 * Whether `userId` may act through their personal MCP connections in this session right now:
 * active, holding `mcp_connections.use` in their live role, and able to read and collaborate on
 * the session. Checked on every turn and every relayed call, so losing any of these stops
 * personal calls at once, including for automation runs queued long before.
 *
 * No request/session positive cache: invoked again after credential I/O.
 */
export async function assertMcpUserAccess(
  db: SqlDatabase,
  env: Env,
  userId: string,
  sessionId: string
): Promise<void> {
  const [authorization, session, memberships, collaboratorIds] = await Promise.all([
    new AuthorizationService(db).getEffectiveAuthorization(userId),
    new SessionIndexStore(db).get(sessionId),
    new TeamMembershipStore(db).listForUser(userId),
    new SessionCollaboratorStore(db).listUserIds(sessionId),
  ]);
  if (
    !session ||
    authorization.suspendedAt !== null ||
    !authorization.permissions.includes(PERSONAL_MCP_PERMISSION)
  )
    throw new McpError("mcp_denied");
  const mode = parseTeamsEnforcementMode(env.TEAMS_ENFORCEMENT);
  const row = { ...session, ownerUserId: session.userId ?? null, collaboratorIds };
  const viewer = {
    kind: "user" as const,
    userId,
    roleKey: authorization.role.key,
    permissions: authorization.permissions,
    suspended: false,
    memberships,
  };
  for (const action of ["read", "collaborate"] as const) {
    const decision = checkSessionAccess(viewer, row, action);
    if (
      resolverDecides(mode, row, action)
        ? !decision.allowed
        : !authorization.permissions.includes(legacyPermissionForAction(action))
    )
      throw new McpError("mcp_denied");
  }
}
