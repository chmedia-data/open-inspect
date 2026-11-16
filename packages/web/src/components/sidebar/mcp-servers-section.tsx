"use client";

import { useSessionMcpServers } from "@/hooks/use-mcp-servers";
import { CollapsibleSection } from "./collapsible-section";

/** The MCP servers this session's sandbox runs, pinned at creation, with any no longer available. */
export function McpServersSection({ sessionId }: { sessionId: string }) {
  const { selection, loading, error } = useSessionMcpServers(sessionId);
  if (error) return null;
  if (loading) return <p className="text-xs text-muted-foreground">Loading MCP servers…</p>;
  if (!selection) return null;
  const active = selection.servers.filter((server) => server.available);
  return (
    <CollapsibleSection title={`MCP servers (${active.length})`} defaultOpen={false}>
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Selection</span>
          <span className="text-foreground">
            {selection.mode === "all" ? "All in scope" : "Selected"}
          </span>
        </div>
        {selection.servers.length === 0 ? (
          <p className="text-muted-foreground">No MCP servers run in this session.</p>
        ) : (
          <ul className="space-y-1">
            {selection.servers.map((server) => (
              <li key={server.id} className="flex items-center justify-between gap-2">
                <span
                  className={`truncate font-mono ${
                    server.available ? "text-foreground" : "text-muted-foreground line-through"
                  }`}
                >
                  {server.name}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {!server.available
                    ? "no longer available"
                    : server.authMode === "user_oauth"
                      ? "personal"
                      : "workspace"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </CollapsibleSection>
  );
}
