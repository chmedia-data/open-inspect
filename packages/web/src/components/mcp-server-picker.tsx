"use client";

import { useId } from "react";
import type {
  McpConnectionStatus,
  McpServerMetadata,
} from "@open-inspect/shared/types/integrations";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type ConnectionStatus = McpConnectionStatus | "not_connected";

export function isPersonalMcpServer(server: Pick<McpServerMetadata, "authMode">): boolean {
  return server.authMode === "user_oauth";
}

/**
 * The servers a picker offers: enabled ones unscoped or scoped to one of `repositories`, plus any
 * already selected so they can be cleared. Environment members are not known here, so a server
 * scoped only to an environment's repositories is not offered for it.
 */
export function mcpPickerServers(
  servers: readonly McpServerMetadata[],
  repositories: readonly string[],
  selected: readonly string[]
): McpServerMetadata[] {
  const repos = new Set(repositories.map((repo) => repo.toLowerCase()));
  return servers.filter(
    (server) =>
      selected.includes(server.id) ||
      (server.enabled &&
        (!server.repoScopes || server.repoScopes.some((scope) => repos.has(scope.toLowerCase()))))
  );
}

function statusLabel(status: ConnectionStatus | undefined): string {
  if (status === "connected") return "connected";
  if (status === "reconnect_required") return "reconnect needed";
  return "not connected";
}

interface McpServerPickerProps {
  servers: readonly McpServerMetadata[];
  connectionStatus: ReadonlyMap<string, ConnectionStatus>;
  /** Selected ids, or null for every server in scope (only when `allowAll`). */
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  allowAll?: boolean;
  /** Why personal servers cannot be added, or null when they can. Selected ones can still be cleared. */
  personalDisabledReason?: string | null;
  disabled?: boolean;
}

export function McpServerPicker({
  servers,
  connectionStatus,
  value,
  onChange,
  allowAll = false,
  personalDisabledReason = null,
  disabled = false,
}: McpServerPickerProps) {
  const id = useId();
  const all = value === null;
  const selected = new Set(value ?? []);
  const toggle = (serverId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(serverId);
    else next.delete(serverId);
    onChange(servers.map((server) => server.id).filter((candidate) => next.has(candidate)));
  };

  return (
    <div className="space-y-2">
      {allowAll && (
        <label htmlFor={`${id}-all`} className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox
            id={`${id}-all`}
            checked={all}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(checked === true ? null : servers.map((server) => server.id))
            }
          />
          All servers in scope
        </label>
      )}
      {servers.length === 0 ? (
        <p className="text-xs text-muted-foreground">No MCP servers are available here.</p>
      ) : (
        <ul className="space-y-1.5">
          {servers.map((server) => {
            const personal = isPersonalMcpServer(server);
            const checked = all || selected.has(server.id);
            const blocked = personal && !!personalDisabledReason && !checked;
            return (
              <li key={server.id}>
                <label
                  htmlFor={`${id}-${server.id}`}
                  className="flex items-center gap-2 text-sm text-foreground"
                  title={blocked ? (personalDisabledReason ?? undefined) : undefined}
                >
                  <Checkbox
                    id={`${id}-${server.id}`}
                    checked={checked}
                    disabled={disabled || blocked || (allowAll && all)}
                    onCheckedChange={(next) => toggle(server.id, next === true)}
                  />
                  <span className="truncate font-mono">{server.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {!server.enabled
                      ? "disabled"
                      : personal
                        ? `personal · ${statusLabel(connectionStatus.get(server.id))}`
                        : "workspace"}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {personalDisabledReason && servers.some(isPersonalMcpServer) && (
        <p className="text-xs text-muted-foreground">{personalDisabledReason}</p>
      )}
    </div>
  );
}

/** The picker behind a compact trigger, for the new-session composer bar. */
export function McpServerPopover(props: McpServerPickerProps) {
  const count = props.value?.length;
  return (
    <Popover>
      <PopoverTrigger
        disabled={props.disabled}
        className="flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        MCP:{" "}
        {count === undefined
          ? "all"
          : count === 0
            ? "none"
            : `${count} server${count === 1 ? "" : "s"}`}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        <McpServerPicker {...props} allowAll />
      </PopoverContent>
    </Popover>
  );
}
