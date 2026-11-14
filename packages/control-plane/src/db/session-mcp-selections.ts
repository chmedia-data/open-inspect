import { bulkInsertStatements } from "./bulk-insert";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/** One server pinned to a session, with its name as it was when the session was created. */
export interface PinnedMcpServer {
  id: string;
  name: string;
}

/**
 * Which MCP servers a session's sandbox runs. `all` runs every enabled server in the session's
 * repository scope; `selected` runs only `servers`, still narrowed by that scope at each launch.
 */
export type SessionMcpSelectionPin =
  { mode: "all" } | { mode: "selected"; servers: PinnedMcpServer[] };

export const ALL_MCP_SERVERS: SessionMcpSelectionPin = { mode: "all" };

/** D1 copy of each session's pinned MCP selection, read by the session view and child spawns. */
export class SessionMcpSelectionStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Statements that record a session's pin. They run in the session-creation batch after the
   * session row is inserted, so the pin commits atomically with the session.
   */
  bindPin(sessionId: string, pin: SessionMcpSelectionPin): SqlStatement[] {
    return [
      this.db
        .prepare("UPDATE sessions SET mcp_selection_mode = ? WHERE id = ?")
        .bind(pin.mode, sessionId),
      ...(pin.mode === "selected"
        ? bulkInsertStatements(
            this.db,
            "session_mcp_servers",
            pin.servers.map((server) => ({
              session_id: sessionId,
              server_id: server.id,
              server_name: server.name,
            }))
          )
        : []),
    ];
  }

  /**
   * The session's pin, or null when the session does not exist. Sessions created before
   * selections existed run every server in scope, so they read as `all`.
   */
  async getPin(sessionId: string): Promise<SessionMcpSelectionPin | null> {
    const session = await this.db
      .prepare("SELECT mcp_selection_mode FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ mcp_selection_mode: string | null }>();
    if (!session) return null;
    if (session.mcp_selection_mode !== "selected") return ALL_MCP_SERVERS;
    const rows = await this.db
      .prepare(
        "SELECT server_id, server_name FROM session_mcp_servers WHERE session_id = ? ORDER BY server_name, server_id"
      )
      .bind(sessionId)
      .all<{ server_id: string; server_name: string }>();
    return {
      mode: "selected",
      servers: (rows.results ?? []).map((row) => ({ id: row.server_id, name: row.server_name })),
    };
  }
}
