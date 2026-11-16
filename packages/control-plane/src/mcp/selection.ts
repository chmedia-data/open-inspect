import type {
  McpServerMetadata,
  SessionMcpSelection,
} from "@open-inspect/shared/types/integrations";
import { McpServerStore } from "../db/mcp-servers";
import { ALL_MCP_SERVERS, type SessionMcpSelectionPin } from "../db/session-mcp-selections";
import type { SqlDatabase } from "../db/sql-database";

/** The permission a session owner needs before personal servers may be selected or used. */
export const PERSONAL_MCP_PERMISSION = "mcp_connections.use" as const;

/** A selection the caller may not make, with the HTTP status and code to answer with. */
export class McpSelectionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
    readonly code: string
  ) {
    super(message);
    this.name = "McpSelectionError";
  }
}

type Repository = { repoOwner: string; repoName: string };

/** Whether a server applies to any of these repositories: unscoped servers apply everywhere. */
export function isMcpServerInScope(
  repoScopes: readonly string[] | null | undefined,
  repositories: readonly Repository[]
): boolean {
  if (!repoScopes?.length) return true;
  const names = new Set(repositories.map((r) => `${r.repoOwner}/${r.repoName}`.toLowerCase()));
  return repoScopes.some((scope) => names.has(scope.toLowerCase()));
}

export function isUserOAuthServer(server: Pick<McpServerMetadata, "authMode">): boolean {
  return server.authMode === "user_oauth";
}

function registry(db: SqlDatabase, encryptionKey: string | undefined): McpServerStore {
  // Metadata reads never decrypt, so a deployment without the key can still validate ids.
  return new McpServerStore(db, encryptionKey ?? "");
}

export interface McpSelectionRequest {
  /** Server ids the caller chose. */
  serverIds: readonly string[];
  /** The repositories the session (or each run of an automation) targets. */
  repositories: readonly Repository[];
  /**
   * Whether the caller may choose personal servers: the session owner holds
   * `mcp_connections.use` within whatever the request may exercise (a token's grant included).
   */
  mayUsePersonal: boolean;
}

/**
 * Check chosen server ids against the registry: each must name an enabled server in the target's
 * scope, and a personal server needs {@link McpSelectionRequest.mayUsePersonal}. Returns the
 * servers in the order chosen; throws {@link McpSelectionError} naming every offending id.
 */
export async function validateMcpServerIds(
  db: SqlDatabase,
  encryptionKey: string | undefined,
  request: McpSelectionRequest
): Promise<McpServerMetadata[]> {
  if (request.serverIds.length === 0) return [];
  const byId = new Map((await registry(db, encryptionKey).list()).map((s) => [s.id, s]));
  const invalid = request.serverIds.filter((id) => {
    const server = byId.get(id);
    return !server?.enabled || !isMcpServerInScope(server.repoScopes, request.repositories);
  });
  if (invalid.length > 0) {
    throw new McpSelectionError(
      `Unknown, disabled or out-of-scope MCP servers: ${invalid.join(", ")}`,
      400,
      "invalid_mcp_servers"
    );
  }
  const servers = request.serverIds.map((id) => byId.get(id)!);
  const personal = servers.filter(isUserOAuthServer);
  if (personal.length > 0 && !request.mayUsePersonal) {
    throw new McpSelectionError(
      `Selecting personal MCP servers (${personal.map((s) => s.name).join(", ")}) requires the ${PERSONAL_MCP_PERMISSION} permission`,
      403,
      "personal_mcp_permission_required"
    );
  }
  return servers;
}

/**
 * Resolve a new session's selection into the pin stored with it. `all` (the default) needs no
 * lookup; `selected` is validated by {@link validateMcpServerIds}.
 */
export async function resolveSessionMcpSelection(
  db: SqlDatabase,
  encryptionKey: string | undefined,
  selection: SessionMcpSelection | undefined,
  request: Omit<McpSelectionRequest, "serverIds">
): Promise<SessionMcpSelectionPin> {
  if (!selection || selection.mode === "all") return ALL_MCP_SERVERS;
  const servers = await validateMcpServerIds(db, encryptionKey, {
    ...request,
    serverIds: selection.serverIds,
  });
  return { mode: "selected", servers: servers.map(({ id, name }) => ({ id, name })) };
}

/**
 * Pin an automation run's stored selection as it stands. Stored ids are not re-validated here:
 * one that has since been deleted is pinned under its id, and the launch filter drops it, along
 * with any disabled or out-of-scope server, with a warning in the session.
 */
export async function pinStoredMcpSelection(
  db: SqlDatabase,
  encryptionKey: string | undefined,
  serverIds: readonly string[]
): Promise<SessionMcpSelectionPin> {
  if (serverIds.length === 0) return { mode: "selected", servers: [] };
  const byId = new Map((await registry(db, encryptionKey).list()).map((s) => [s.id, s]));
  return {
    mode: "selected",
    servers: serverIds.map((id) => ({ id, name: byId.get(id)?.name ?? id })),
  };
}

/** The stored ids that currently name a personal (`user_oauth`) server. */
export async function personalMcpServerIds(
  db: SqlDatabase,
  encryptionKey: string | undefined,
  serverIds: readonly string[]
): Promise<string[]> {
  if (serverIds.length === 0) return [];
  const byId = new Map((await registry(db, encryptionKey).list()).map((s) => [s.id, s]));
  return serverIds.filter((id) => {
    const server = byId.get(id);
    return server !== undefined && isUserOAuthServer(server);
  });
}
