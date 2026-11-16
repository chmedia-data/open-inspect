-- Per-session MCP selection, pinned at creation (docs/proposals/session-mcp-selection.md).
--
-- `sessions.mcp_selection_mode` is NULL for rows that predate this migration, which run every
-- enabled MCP server in their scope exactly as 'all' does. 'selected' sessions run only the
-- servers pinned in session_mcp_servers, still narrowed by repository scope at each launch.
ALTER TABLE sessions ADD COLUMN mcp_selection_mode TEXT
  CHECK (mcp_selection_mode IS NULL OR mcp_selection_mode IN ('all', 'selected'));

-- No foreign key to mcp_servers: deleting a server must not be blocked by sessions that selected
-- it. The launch filter drops a dangling id with a warning; `server_name` keeps it nameable.
CREATE TABLE session_mcp_servers (
  session_id  TEXT NOT NULL,
  server_id   TEXT NOT NULL,
  server_name TEXT NOT NULL,
  PRIMARY KEY (session_id, server_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- The MCP servers each run of an automation selects, as a JSON array of server ids. Existing
-- automations start with none: this is a deliberate behaviour change, not a backfill.
ALTER TABLE automations ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]';
