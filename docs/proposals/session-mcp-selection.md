# Per-session MCP selection and automations that store one

Status: phase 1, implemented on `feat/session-mcp-selection`.

## Problem

Every sandbox loads every enabled MCP server whose repository scope matches the session. Nobody can
narrow that per session, and automations cannot use personal (`user_oauth`) servers at all: every
automation turn is queued with `mcp_eligible = 0`, so personal servers are skipped silently
(`session/mcp-context.ts`, "automation turns have no author to delegate as"). Users want to choose,
per session and per automation, which MCP servers are active in the sandbox, and want scheduled
automations to use their own personal connections.

## Scope

Phase 1 only:

- Every session type (web, API/PAT/MCP `create_session`, Slack, child spawns, automations) can carry
  an MCP selection, pinned at creation and applied at every launch (spawn, restore, snapshot
  restore).
- Automations store a selection and apply it to each run. Personal servers in an automation's
  selection act as the automation owner.

Out of scope: changing the selection of a running session (phase 2) and other sandbox capabilities
such as skills or code-server per automation (phase 3).

## Decisions

| Question                                                             | Decision                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing automations after the migration                             | Start empty: every existing automation gets `[]` (no MCP servers). No backfill. This is a behaviour change.                                                                                                                                                                                                                               |
| New automations                                                      | Default to `[]`.                                                                                                                                                                                                                                                                                                                          |
| Interactive sessions created without a selection                     | Keep today's behaviour: all in-scope servers (`{ mode: "all" }`).                                                                                                                                                                                                                                                                         |
| Event-triggered automations (GitHub, Linear, Slack, Sentry, webhook) | May not select personal servers. Refused at save time. Schedule automations, fired by schedule or by a manual trigger, may.                                                                                                                                                                                                               |
| Manual trigger by someone other than the owner                       | Runs without personal servers and emits an `mcp` warning.                                                                                                                                                                                                                                                                                 |
| Team-owned automations                                               | May not select personal servers.                                                                                                                                                                                                                                                                                                          |
| Editing an automation that selects personal servers                  | Owner lock: only the owner, acting as themselves (browser, or their own token holding `mcp_connections.use`), may change it. Anyone else, including holders of `automations.manage.any`, gets 403 `automation_owner_locked`. Pause, resume and delete keep their existing rules, so an administrator can still stop a runaway automation. |
| `mcp_connections.use` on the live role                               | Checked on every turn and on every personal call, for all sessions, not only when a prompt is accepted.                                                                                                                                                                                                                                   |
| Personal servers in a selection                                      | Allowed only when the session owner holds `mcp_connections.use`. A token caller additionally needs the grant.                                                                                                                                                                                                                             |
| Service-account workaround                                           | Not shipped. No deployment config changes.                                                                                                                                                                                                                                                                                                |

## Design

### Data model (D1 migration `0098_session_mcp_selection.sql`)

- `sessions.mcp_selection_mode TEXT NULL` (`'all' | 'selected'`). NULL means `'all'` for rows that
  predate the migration.
- `session_mcp_servers(session_id, server_id, server_name, PRIMARY KEY (session_id, server_id))`,
  the pinned ids for `'selected'` sessions. The name is a snapshot so a deleted server can still be
  shown as "no longer available".
- `automations.mcp_server_ids TEXT NOT NULL DEFAULT '[]'`, a JSON array of server ids. An empty
  array means no MCP servers.
- Ids, not names, are stored, so a rename keeps the selection. `auth_revision` is not stored; a
  server whose settings change stays selected and the reconnect handling covers it.
- The session Durable Object keeps its own copy (`session.mcp_selection`, JSON of `{id, name}`
  entries, NULL for all) written at init, so launch and restore never read D1 for it.

### Shared contract

- `createSessionRequestBaseSchema.mcpSelection`:
  `{ mode: "all" } | { mode: "selected", serverIds: string[] }`, at most 32 unique ids.
- `createAutomationRequestSchema.mcpServerIds` and `updateAutomationRequestSchema.mcpServerIds`: at
  most 32 unique ids. Create defaults to `[]`; update replaces the stored list when present.
- `Automation.mcpServerIds` in responses.
- `SessionMcpSelectionView` for `GET /sessions/:id/mcp-servers`:
  `{ mode, servers: [{ id, name, authMode, available }] }`. Never credentials.

### Validation at creation

- Every id must be an enabled server that is unscoped or scoped to one of the target's repositories
  (environment members included). Otherwise 400 naming the ids.
- A personal id requires `mcp_connections.use` in the caller's effective permissions. For a browser
  user that is their role; for a token it is the grant intersected with the owner's role, so a token
  needs the grant too. Otherwise 403.
- Whether the owner currently has a live connection does not block creation. A missing connection is
  reported per turn, as today.
- Choosing workspace servers needs no new permission: a selection only narrows.

### Launch filter

- `McpServerStore.getForLaunch(repositories, selection)` applies the repository-scope filter and
  then, for `'selected'` sessions, keeps only the selected ids. Disabled, deleted or out-of-scope
  ids are dropped. The selection never widens scope.
- `SandboxLaunchContext.loadMcpServers` reads the pinned selection from the session row, so fresh
  spawn, restore and snapshot restore all apply it.
- Dropped ids produce one `mcp` warning per launch: "Selected MCP server X is disabled, deleted or
  no longer in scope for this session".

### Children

A child copies its parent's pin verbatim (D1 rows and the DO copy), like managed skills
(`inheritedPin`). Personal eligibility keeps the existing rule: only the parent's own sandbox passes
its turn's eligibility to the child's first prompt.

### Automations

- Validation on save, in addition to the session rules: personal ids are refused for team
  automations (400 `team_automation_personal_mcp`) and for non-schedule triggers (400
  `event_trigger_personal_mcp`), and require that the caller is the owner (403).
- Owner lock (see Decisions). The lock is decided from the stored selection: it applies while any
  stored id currently names a `user_oauth` server.
- At admission (`AutomationInvocationService.start` and `admitRetry`), `ExecutionPrincipal` gains
  `mcpEligible`, true only when all hold: the selection names a personal server; the source is
  `schedule` or `manual`; the automation is not team-owned; the execution principal is the owner;
  the owner's live role holds `mcp_connections.use`; and a manual firing's permission ceiling (a
  token's grant) includes it.
- `enqueueAutomationFirstPrompt` sends `mcpEligible`. The DO already stores and enforces it, and
  `prepare` binds the owner's connections because the prompt's canonical user is the owner.
- Continuation prompts (Slack thread replies, webhook follow-ups) stay ineligible.
- An automation turn that is not eligible while the sandbox has personal servers gets one `mcp`
  warning naming them, instead of today's silence.

### Revocation and disconnects

- Disconnected, revoked or reconnect-required connections are reported per turn
  (`mcp_connection_required`, `mcp_reconnect_required`), as today.
- A disabled or changed server is refused by the relay and dropped at the next launch with a
  warning.
- A suspended owner, or one who lost session access, is refused per call by `assertMcpUserAccess`.
- New: `assertMcpUserAccess` also requires `mcp_connections.use` on the live role, so losing the
  permission stops personal calls on the next turn and the next call, for every session.
- Revoking or downgrading a token does not stop runs it already triggered (documented limitation).
- Deleting a server referenced by an automation is not blocked; the id dangles, the launch filter
  drops it with a warning, and the automation view marks it unavailable.

### Surfaces

- `POST /sessions` and the web `/api/sessions` proxy accept `mcpSelection`.
- `GET /sessions/:id/mcp-servers` returns the pinned selection view.
- Automation create and update accept `mcpServerIds`.
- `GET /mcp-servers` and `GET /mcp-connections` accept personal access tokens (read-only), so the
  MCP server package can list ids and the caller's connection status.
- MCP tools: `list_mcp_servers` (read-only), `mcp_server_ids` on `create_session` and
  `create_automation`.
- Web: an MCP picker on the new-session form (default all) and on the automation form (default none,
  personal servers disabled with a reason where not allowed), and the active servers in the session
  sidebar.

## Security notes

- Narrowing a selection is strictly safer than today.
- The new risk is unattended runs acting as the owner at external services on instructions written
  earlier. It is bounded by: schedule and owner-manual only; no team automations; the owner lock on
  edits; and per-firing, per-turn and per-call re-checks of the owner's role.
- The #2620 known gap still applies: a process left over from an earlier turn in the same sandbox
  can call personal servers during an eligible turn. Automation sessions are single-author, which
  makes this less exposed than shared interactive sessions.

## Known gaps

- No `update_automation` MCP tool exists, so changing an automation's selection needs the web app or
  the REST API.
- The selection of a running session cannot change (phase 2).

## Handover (2026-11-14)

Branch `feat/session-mcp-selection` on `chm`, based on `chm/chm` (35fffc8e). Development moves to
the vulcan host. No PR is open yet.

### Done (committed)

1. `docs:` this proposal.
2. `feat(shared):` `sessionMcpSelectionSchema`, `mcpServerIdsSchema`, `SessionMcpSelectionView`
   (`packages/shared/src/types/managed-mcp.ts`), `mcpSelection` on session create, `mcpServerIds` on
   automation create, update and response (defaults to `[]`), with schema tests.
3. `feat:` storage. D1 migration `0098_session_mcp_selection.sql`, `SessionMcpSelectionStore`
   (`db/session-mcp-selections.ts`), the pin written in the session-create batch, the
   `automations.mcp_server_ids` column, and the DO `session.mcp_selection` column (DO migration 60).
4. `feat:` launch filter. `McpServerStore.getForLaunch(repositories, selectedIds)`,
   `SandboxLaunchContext.loadMcpServers(session, repositories)` applied at fresh spawn, restore and
   snapshot restore, and one `mcp` warning per launch for dropped servers. Session create validates
   and pins (`mcp/selection.ts`), a child inherits its parent's pin, and an automation run pins its
   stored ids. Adds `GET /sessions/:id/mcp-servers` (`routes/session-mcp-servers.ts`). Route catalog
   snapshots were regenerated (see below).
5. `feat:` the per-turn check. `assertMcpUserAccess` requires `mcp_connections.use` on the live
   role, on every turn (`prepare`) and every relayed call. Automation turns that cannot use their
   selected personal servers now get an `mcp` warning instead of silence (`mcp-context.ts`).
6. `feat:` automations. `isPersonalMcpEligible` (`scheduler/personal-mcp-eligibility.ts`) is decided
   at admission and on each retry, and the first prompt sends `mcpEligible`. Save-time rules and the
   owner lock are in `routes/automation-mcp.ts`, wired into create and `PUT`.

Tests added: shared schema tests; unit tests in `db/mcp-servers.test.ts`,
`sandbox/lifecycle/manager-mcp.test.ts`, `scheduler/launch-services.test.ts`,
`scheduler/personal-mcp-eligibility.test.ts`, `scheduler/invocation-services.test.ts` and
`scheduler/session-prompt.test.ts`; integration tests in `session-mcp-selection.test.ts`,
`automation-mcp-selection.test.ts`, `spawn-children.test.ts` and `managed-mcp-proxy.test.ts`.

Last local run, before the final commit's formatting only: control-plane unit 5763 passed,
integration 2828 passed, shared 1465 passed.

### In progress

Nothing is half-written. The next step had not started.

### Remains

1. MCP server package (`packages/mcp-server/src/tools.ts`, kept self-contained because
   `fix/reject-unknown-models` also edits it): `list_mcp_servers` (read-only), `mcp_server_ids` on
   `create_session` and `create_automation`, updated descriptions (personal servers act as the token
   owner, need the `mcp_connections.use` grant, schedule automations only), and tool tests.
   `GET /mcp-servers` (`MCP_READ` in `routes/mcp-servers.ts`) and `GET /mcp-connections` do not
   accept tokens yet. Add `personalAccessTokens: "accept"` to the list routes (check that the
   `ACTIVE_SELF` user route admits a token principal), then regenerate the route snapshots.
2. Web: an MCP picker next to `session-skill-selector.tsx` on the new-session form
   (`app/(app)/(sidebar)/page.tsx`, `hooks/use-warm-draft-session.ts`, `/api/sessions` proxy passing
   `mcpSelection`), default all. The same picker on the automation form (`components/automations/`),
   default none, with personal servers disabled and a reason given for team automations,
   non-schedule triggers and non-owners, and an owner-lock notice. A sidebar section next to
   `sidebar/memories-section.tsx` reading `GET /sessions/:id/mcp-servers`. Component and API route
   tests.
3. Docs: `packages/docs/content/docs/configure/mcp-servers.mdx` (~line 119 and the troubleshooting
   entry at ~167-176), the automations docs (selection, "existing automations start empty", the
   owner lock), `packages/mcp-server/README.md`, and a `CHANGELOG.md` entry naming D1 migration 0098
   and the behaviour change.
4. Rebuild for the PR, per the fork convention in the brief. Recreate the branch as
   `session-mcp-selection` off `chm/mcp-session-tools` by cherry-picking these commits, then
   regenerate the route snapshots there. Expect small conflicts in `db/mcp-servers.ts`,
   `shared/src/types/managed-mcp.ts` and `mcp-servers.mdx`, which differ between `chm/chm` and
   `chm/mcp-session-tools`. Run the suites on that branch and on a local merge into `chm/chm`. Open
   the PR with base `mcp-session-tools`, and do not merge.
5. PR description: what changed; behaviour changes (existing automations lose MCP servers; personal
   servers now need `mcp_connections.use` on every turn for everyone; automation turns that cannot
   use personal servers now warn); migration notes (D1 0098, DO migration 60); known gaps (no
   `update_automation` tool, no mid-session change); verification.

### CI and failing checks

- GitHub Actions are disabled on `chmedia-data/open-inspect` (`actions/permissions` reports
  `enabled: false`), so no PR will get CI. Verification is the local suite output.
- `npm run typecheck -w @open-inspect/control-plane` fails in
  `test/integration/mcp-oauth-client-id.test.ts` (TS18048, `server.authRevision` possibly
  undefined). This branch does not touch that file. It comes from the `mcp-preregistered-oauth`
  merge on `chm/chm`, and the failure was not re-checked on a clean base.
- The route catalog snapshot (`hono-route-catalog-conformance.test.ts.snap`) was stale on the base:
  it lacked the `personalAccessTokens: "accept"` opt-ins on `POST /sessions`,
  `POST /sessions/:id/stop` and `POST /sessions/:id/prompt`. Regenerating it for the new route fixed
  those too. Re-check this on the `mcp-session-tools` rebuild.
- Lint (`eslint`) passed on the files touched up to the per-turn check commit. The automation step
  was formatted with Prettier but not re-linted.
