"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  MCP_OAUTH_LOOPBACK_REDIRECT_URI,
  type McpPersonalConnection,
} from "@open-inspect/shared/types/integrations";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const labels = {
  connected: "Connected",
  disconnected: "Disconnected",
  reconnect_required: "Reconnect required",
  not_connected: "Not connected",
};
export function McpConnectionsSettings() {
  const { data, error, isLoading, mutate } = useSWR<{ connections: McpPersonalConnection[] }>(
    "/api/mcp-connections"
  );
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("mcp");
    if (result === "connected") toast.success("MCP account connected");
    if (result === "reconnect_required")
      toast.error("Connection was not completed. Please try connecting again.");
    if (result) {
      url.searchParams.delete("mcp");
      window.history.replaceState(null, "", url);
    }
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  // Loopback servers: consent opens in a new tab and the user pastes the redirect URL back here.
  const [pending, setPending] = useState<{ serverId: string; authorizationUrl: string } | null>(
    null
  );
  const [pasted, setPasted] = useState("");
  async function act(serverId: string, disconnect: boolean, loopback = false) {
    setBusy(serverId);
    try {
      const response = await browserApiFetch(
        `/api/mcp-connections/${encodeURIComponent(serverId)}${disconnect ? "" : "/connect"}`,
        { method: disconnect ? "DELETE" : "POST" }
      );
      if (!response.ok)
        throw new Error("Connection unavailable. Try again or contact your administrator.");
      if (disconnect) {
        if (pending?.serverId === serverId) setPending(null);
        await mutate();
        toast.success("Disconnected from Open Inspect");
      } else {
        const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
        const url = new URL(authorizationUrl);
        if (url.protocol !== "https:") throw new Error("Invalid authorization destination");
        if (loopback) {
          setPasted("");
          setPending({ serverId, authorizationUrl: url.toString() });
        } else window.location.assign(url.toString());
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connection failed");
    } finally {
      setBusy(null);
    }
  }
  async function complete() {
    setBusy(pending!.serverId);
    try {
      const response = await browserApiFetch("/api/mcp-connections/oauth/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pasted }),
      });
      if (response.status === 400)
        throw new Error("Paste the full localhost address shown after signing in.");
      const { status } = (await response.json()) as { status?: string };
      if (status !== "connected")
        throw new Error("Connection was not completed. Please try connecting again.");
      setPending(null);
      await mutate();
      toast.success("MCP account connected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connection failed");
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Your MCP connections</h2>
        <p className="text-sm text-muted-foreground">
          Connect your own account to use integrations with your permissions. Connections belong to
          you; session outputs remain shared.
        </p>
      </div>
      {isLoading && <p>Loading connections…</p>}
      {error && <p role="alert">Unable to load your connections.</p>}
      {!isLoading && !error && !data?.connections.length && (
        <p className="text-sm text-muted-foreground">
          No personal integrations are available. An administrator can add one in MCP Servers.
        </p>
      )}
      {data?.connections.map((connection) => (
        <div key={connection.serverId} className="space-y-4 rounded-md border p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="font-medium">{connection.name}</h3>
              <p className="text-sm text-muted-foreground">
                Personal OAuth · {labels[connection.status]}
                {!connection.enabled ? " · Unavailable" : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                disabled={busy !== null || !connection.enabled}
                onClick={() =>
                  void act(connection.serverId, false, connection.redirect === "loopback")
                }
              >
                {connection.status === "not_connected" || connection.status === "disconnected"
                  ? "Connect"
                  : "Reconnect"}
              </Button>
              {connection.status !== "not_connected" && connection.status !== "disconnected" && (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void act(connection.serverId, true)}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </div>
          {pending?.serverId === connection.serverId && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void complete();
              }}
            >
              <p className="text-sm text-muted-foreground">
                <a
                  href={pending.authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Open the sign-in page
                </a>{" "}
                and approve access. You will end up on a page saying the site can’t be reached
                (localhost); that is expected. Copy the full address from that tab’s address bar and
                paste it here.
              </p>
              <div className="flex gap-2">
                <Input
                  aria-label="Redirect URL"
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                  placeholder={`${MCP_OAUTH_LOOPBACK_REDIRECT_URI}?code=…&state=…`}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="submit" disabled={busy !== null || !pasted.trim()}>
                  Complete connection
                </Button>
              </div>
            </form>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Disconnecting prevents new use through Open Inspect. It does not undo actions already
        submitted or revoke the account at the external service.
      </p>
    </section>
  );
}
