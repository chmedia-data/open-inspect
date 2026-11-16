import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  sessionMcpSelectionViewSchema,
  type CreateMcpServerRequest,
  type McpPersonalConnection,
  type McpServerMetadata,
  type UpdateMcpServerRequest,
} from "@open-inspect/shared/types/integrations";
import { browserApiJson } from "@/lib/browser-api-json";

const MCP_SERVERS_KEY = "/api/mcp-servers";

/** A refused MCP server request; the status lets callers explain a specific refusal. */
export class McpServerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "McpServerRequestError";
  }
}

export function useMcpServers() {
  const { data: session } = useAuthSession();

  const { data, isLoading, mutate } = useSWR<McpServerMetadata[]>(session ? MCP_SERVERS_KEY : null);

  return {
    servers: data ?? [],
    loading: isLoading,
    mutate,
  };
}

/** The caller's own connection status per personal server, keyed by server id. */
export function useMcpConnectionStatus() {
  const { data: session } = useAuthSession();
  const { data } = useSWR<{ connections: McpPersonalConnection[] }>(
    session ? "/api/mcp-connections" : null
  );
  return new Map(data?.connections.map((connection) => [connection.serverId, connection.status]));
}

/** The MCP servers a session pinned at creation, as `GET /sessions/:id/mcp-servers` reports them. */
export function useSessionMcpServers(sessionId: string) {
  const { data, isLoading, error } = useSWR(
    `/api/sessions/${encodeURIComponent(sessionId)}/mcp-servers` as const,
    (path) => browserApiJson(path, sessionMcpSelectionViewSchema, "MCP server request failed")
  );
  return { selection: data, loading: isLoading, error };
}

export async function createMcpServer(config: CreateMcpServerRequest): Promise<McpServerMetadata> {
  const response = await browserApiFetch(MCP_SERVERS_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to create MCP server");
  }
  return response.json();
}

export async function updateMcpServer(
  id: string,
  patch: UpdateMcpServerRequest
): Promise<McpServerMetadata> {
  const response = await browserApiFetch(`${MCP_SERVERS_KEY}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to update MCP server");
  }
  return response.json();
}

export async function deleteMcpServer(id: string): Promise<void> {
  const response = await browserApiFetch(`${MCP_SERVERS_KEY}/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new McpServerRequestError(error.error || "Failed to delete MCP server", response.status);
  }
}

/** Disconnects every user's personal connection to a disabled server. */
export async function revokeMcpConnections(id: string): Promise<void> {
  const response = await browserApiFetch(`${MCP_SERVERS_KEY}/${id}/revoke-connections`, {
    method: "POST",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to revoke MCP connections");
  }
}
