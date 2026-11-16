import type { AutomationInvocationSource } from "@open-inspect/shared/types/automations";
import { parseAutomationMcpServerIds, type AutomationRow } from "../db/automation-store";
import { PERSONAL_MCP_PERMISSION } from "../mcp/selection";
import type { ExecutionPrincipal } from "./launch-contracts";

export interface PersonalMcpEligibilityDeps {
  /** The ids, of those given, that currently name a personal (`user_oauth`) server. */
  personalServerIds(serverIds: readonly string[]): Promise<string[]>;
  /** Whether the user is active and their live role holds `mcp_connections.use`. */
  holdsPersonalMcpPermission(userId: string): Promise<boolean>;
}

export interface PersonalMcpEligibilityInput {
  automation: AutomationRow;
  source: AutomationInvocationSource;
  executionPrincipal: ExecutionPrincipal;
}

/**
 * Whether a firing's first prompt may use the personal MCP servers its automation selects, acting
 * as the automation's owner. Decided at admission for every firing and every retry, so a change to
 * the owner's role or the selection applies from the next one. All must hold:
 *
 * - the automation is not team-owned and runs on a schedule;
 * - the firing came from that schedule or a manual trigger, never from an event, whose prompt
 *   carries text from outside the team;
 * - it executes as the owner, so a manual trigger by anyone else runs without them;
 * - the selection names a personal server;
 * - a manual firing's permission ceiling (a token's grant) includes `mcp_connections.use`;
 * - the owner is active and their live role holds `mcp_connections.use`.
 */
export async function isPersonalMcpEligible(
  deps: PersonalMcpEligibilityDeps,
  { automation, source, executionPrincipal }: PersonalMcpEligibilityInput
): Promise<boolean> {
  if (source === "event" || automation.trigger_type !== "schedule") return false;
  if (automation.owner_team_id !== null || !automation.user_id) return false;
  if (executionPrincipal.platformUserId !== automation.user_id) return false;
  if (
    executionPrincipal.permissionCeiling &&
    !executionPrincipal.permissionCeiling.includes(PERSONAL_MCP_PERMISSION)
  )
    return false;
  const personal = await deps.personalServerIds(parseAutomationMcpServerIds(automation));
  if (personal.length === 0) return false;
  return deps.holdsPersonalMcpPermission(automation.user_id);
}
