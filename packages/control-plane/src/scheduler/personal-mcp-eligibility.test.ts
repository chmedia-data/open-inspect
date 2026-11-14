import { describe, expect, it, vi } from "vitest";
import type { AutomationRow } from "../db/automation-store";
import type { ExecutionPrincipal } from "./launch-contracts";
import {
  isPersonalMcpEligible,
  type PersonalMcpEligibilityDeps,
  type PersonalMcpEligibilityInput,
} from "./personal-mcp-eligibility";

const OWNER = "owner-1";
const automation: AutomationRow = {
  id: "auto-1",
  name: "Morning report",
  instructions: "Summarize the tracker",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_once_at: null,
  schedule_tz: "UTC",
  harness: "opencode",
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: 1,
  consecutive_failures: 0,
  mcp_server_ids: JSON.stringify(["tracker", "docs"]),
  created_by: "author-1",
  user_id: OWNER,
  owner_team_id: null,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};
const owner: ExecutionPrincipal = {
  platformUserId: OWNER,
  participantUserId: "author-1",
  scmEnrichment: null,
};

function deps(options: { personal?: string[]; permitted?: boolean } = {}) {
  return {
    personalServerIds: vi
      .fn<PersonalMcpEligibilityDeps["personalServerIds"]>()
      .mockResolvedValue(options.personal ?? ["tracker"]),
    holdsPersonalMcpPermission: vi
      .fn<PersonalMcpEligibilityDeps["holdsPersonalMcpPermission"]>()
      .mockResolvedValue(options.permitted ?? true),
  } satisfies PersonalMcpEligibilityDeps;
}

function input(overrides: Partial<PersonalMcpEligibilityInput> = {}): PersonalMcpEligibilityInput {
  return { automation, source: "schedule", executionPrincipal: owner, ...overrides };
}

describe("isPersonalMcpEligible", () => {
  it("lets a scheduled firing act as an owner who holds mcp_connections.use", async () => {
    const d = deps();
    expect(await isPersonalMcpEligible(d, input())).toBe(true);
    expect(d.personalServerIds).toHaveBeenCalledWith(["tracker", "docs"]);
    expect(d.holdsPersonalMcpPermission).toHaveBeenCalledWith(OWNER);
  });

  it("refuses when the owner's live role lacks the permission, as on a later retry", async () => {
    expect(await isPersonalMcpEligible(deps({ permitted: false }), input())).toBe(false);
  });

  it("refuses when the selection names no personal server", async () => {
    const d = deps({ personal: [] });
    expect(await isPersonalMcpEligible(d, input())).toBe(false);
    expect(d.holdsPersonalMcpPermission).not.toHaveBeenCalled();
  });

  it("lets the owner's own manual firing through, and a token only with the grant", async () => {
    expect(await isPersonalMcpEligible(deps(), input({ source: "manual" }))).toBe(true);
    expect(
      await isPersonalMcpEligible(
        deps(),
        input({
          source: "manual",
          executionPrincipal: { ...owner, permissionCeiling: ["automations.trigger.own"] },
        })
      )
    ).toBe(false);
    expect(
      await isPersonalMcpEligible(
        deps(),
        input({
          source: "manual",
          executionPrincipal: {
            ...owner,
            permissionCeiling: ["automations.trigger.own", "mcp_connections.use"],
          },
        })
      )
    ).toBe(true);
  });

  it("never acts as the owner for a manual firing by someone else", async () => {
    const d = deps();
    expect(
      await isPersonalMcpEligible(
        d,
        input({ source: "manual", executionPrincipal: { ...owner, platformUserId: "admin-1" } })
      )
    ).toBe(false);
    expect(d.holdsPersonalMcpPermission).not.toHaveBeenCalled();
  });

  it("refuses event firings, event-triggered automations and team automations", async () => {
    expect(await isPersonalMcpEligible(deps(), input({ source: "event" }))).toBe(false);
    expect(
      await isPersonalMcpEligible(
        deps(),
        input({ source: "manual", automation: { ...automation, trigger_type: "webhook" } })
      )
    ).toBe(false);
    expect(
      await isPersonalMcpEligible(
        deps(),
        input({ automation: { ...automation, owner_team_id: "team_a" } })
      )
    ).toBe(false);
  });
});
