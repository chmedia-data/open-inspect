import { Hono } from "hono";
import type { SessionMcpSelectionView } from "@open-inspect/shared/types/integrations";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { McpServerStore } from "../db/mcp-servers";
import { SessionMcpSelectionStore } from "../db/session-mcp-selections";
import type { SqlDatabase } from "../db/sql-database";
import { isMcpServerInScope } from "../mcp/selection";
import type { Env } from "../types";
import {
  error,
  json,
  requireSession,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

async function sessionRepositories(
  db: SqlDatabase,
  sessionId: string
): Promise<{ repoOwner: string; repoName: string }[]> {
  const rows = await db
    .prepare(
      `SELECT repo_owner, repo_name FROM session_repositories WHERE session_id = ?
       UNION SELECT repo_owner, repo_name FROM sessions
       WHERE id = ? AND repo_owner IS NOT NULL AND repo_name IS NOT NULL`
    )
    .bind(sessionId, sessionId)
    .all<{ repo_owner: string; repo_name: string }>();
  return (rows.results ?? []).map((row) => ({
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
  }));
}

/**
 * The session's pinned MCP selection with each server's current availability. Names and auth
 * modes only: never URLs, headers or credentials.
 */
export async function handleSessionMcpServers(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const pin = await new SessionMcpSelectionStore(ctx.db).getPin(params.id);
  if (!pin) return error("Session not found", 404);
  const [servers, repositories] = await Promise.all([
    new McpServerStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY ?? "").list(),
    sessionRepositories(ctx.db, params.id),
  ]);
  const usable = (server: (typeof servers)[number]) =>
    server.enabled && isMcpServerInScope(server.repoScopes, repositories);
  const view: SessionMcpSelectionView =
    pin.mode === "all"
      ? {
          mode: "all",
          servers: servers.filter(usable).map((server) => ({
            id: server.id,
            name: server.name,
            authMode: server.authMode ?? null,
            available: true,
          })),
        }
      : {
          mode: "selected",
          servers: pin.servers.map((pinned) => {
            const server = servers.find((candidate) => candidate.id === pinned.id);
            return {
              id: pinned.id,
              name: server?.name ?? pinned.name,
              authMode: server?.authMode ?? null,
              available: server !== undefined && usable(server),
            };
          }),
        };
  const response = json(view);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const sessionMcpServerRoutes = new Hono<ControlPlaneHonoEnv>();

sessionMcpServerRoutes.get(
  "/sessions/:id/mcp-servers",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requireSession("read") }),
  (c) => dispatch(c, handleSessionMcpServers)
);
