import { z } from "zod";

export const mcpAuthModeSchema = z.enum(["none", "service_credentials", "user_oauth"]);
export type McpAuthMode = z.infer<typeof mcpAuthModeSchema>;

/** Explicit legacy default, including credential-free legacy remote definitions. */
export const DEFAULT_MCP_AUTH_MODE = "service_credentials" as const;
export const MANAGED_MCP_VERSION = 1 as const;

/** RFC 6749 §3.3 scope-token: printable ASCII without space, double quote or backslash. */
export const MCP_OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * Public HTTPS Streamable HTTP, public OAuth client with S256 PKCE. The client registers itself
 * dynamically unless `clientId` names one the authorization server already knows, for servers
 * without dynamic client registration (such as Snowflake, where an administrator creates the
 * OAuth integration with Open Inspect's callback URL). `scopes`, when set, is exactly what every
 * connection requests; unset, no scope is sent and the authorization server applies its default.
 */
export const mcpOAuthProfileSchema = z.strictObject({
  issuer: z.url(),
  resource: z.url(),
  clientId: z.string().trim().min(1).max(512).optional(),
  scopes: z.array(z.string().regex(MCP_OAUTH_SCOPE_TOKEN)).min(1).max(32).optional(),
});
export type McpOAuthProfile = z.infer<typeof mcpOAuthProfileSchema>;

export interface ManagedMcpServerConfig {
  id: string;
  name: string;
  type: "remote";
  url: string;
  headers: { Authorization: string };
  enabled: boolean;
  managed_proxy: {
    version: typeof MANAGED_MCP_VERSION;
    auth_mode: McpAuthMode;
    auth_revision: number;
  };
}

export type McpConnectionStatus = "connected" | "disconnected" | "reconnect_required";
export interface McpPersonalConnection {
  enabled: boolean;
  serverId: string;
  name: string;
  authMode: McpAuthMode;
  status: McpConnectionStatus | "not_connected";
}

/** Lifecycle correlation only; not a request-origin credential or mutable URL. */
export interface ManagedMcpExecution {
  connectionUrl?: string;
  messageId: string;
  revision: number;
  servers: string[];
  unavailable: { name: string; code: string }[];
}

/** Most MCP servers one session or automation may select. */
export const MAX_MCP_SELECTION_SERVERS = 32;

/** Server ids chosen for a session or an automation: unique, at most {@link MAX_MCP_SELECTION_SERVERS}. */
export const mcpServerIdsSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(MAX_MCP_SELECTION_SERVERS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "must not contain duplicates" });

/**
 * Which MCP servers a session's sandbox runs, pinned at creation. `all` is every enabled server in
 * the session's repository scope (the default); `selected` narrows that to the listed ids and
 * never widens it. An empty `serverIds` runs no MCP server at all.
 */
export const sessionMcpSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({ mode: z.literal("selected"), serverIds: mcpServerIdsSchema }),
]);
export type SessionMcpSelection = z.infer<typeof sessionMcpSelectionSchema>;

/**
 * One server of a session's pinned selection as the session view shows it. `available` is false
 * when the server is deleted, disabled, or out of the session's scope; `authMode` is null once the
 * server is deleted.
 */
export const sessionMcpServerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  authMode: mcpAuthModeSchema.nullable(),
  available: z.boolean(),
});
export type SessionMcpServerView = z.infer<typeof sessionMcpServerViewSchema>;

/**
 * `GET /sessions/:id/mcp-servers`. For `all`, `servers` lists the enabled servers currently in
 * the session's scope; for `selected`, the pinned servers, available or not. Never credentials.
 */
export const sessionMcpSelectionViewSchema = z.object({
  mode: z.enum(["all", "selected"]),
  servers: z.array(sessionMcpServerViewSchema),
});
export type SessionMcpSelectionView = z.infer<typeof sessionMcpSelectionViewSchema>;
