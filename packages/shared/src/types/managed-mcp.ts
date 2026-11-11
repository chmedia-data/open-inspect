import { z } from "zod";

export const mcpAuthModeSchema = z.enum(["none", "service_credentials", "user_oauth"]);
export type McpAuthMode = z.infer<typeof mcpAuthModeSchema>;

/** Explicit legacy default, including credential-free legacy remote definitions. */
export const DEFAULT_MCP_AUTH_MODE = "service_credentials" as const;
export const MANAGED_MCP_VERSION = 1 as const;

/**
 * Public HTTPS Streamable HTTP, public OAuth client with S256 PKCE. The client registers itself
 * dynamically unless `clientId` names one the authorization server already knows, for servers
 * without dynamic client registration (such as Snowflake, where an administrator creates the
 * OAuth integration with Open Inspect's callback URL).
 */
export const mcpOAuthProfileSchema = z.strictObject({
  issuer: z.url(),
  resource: z.url(),
  clientId: z.string().trim().min(1).max(512).optional(),
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
