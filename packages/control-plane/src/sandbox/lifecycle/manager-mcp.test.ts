import { describe, expect, it, vi } from "vitest";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
} from "./test-helpers";
describe("personal MCP servers at launch", () => {
  const personal: McpServerConfig = {
    id: "personal",
    name: "tracker",
    type: "remote",
    url: "https://mcp.example.com/mcp",
    enabled: true,
    authMode: "user_oauth",
    authRevision: 2,
  };
  const service: McpServerConfig = {
    id: "service",
    name: "docs",
    type: "remote",
    url: "https://docs.example.com/mcp",
    enabled: true,
    authMode: "service_credentials",
    headers: { Authorization: "Bearer service" },
  };

  async function launch(
    kind: "spawn" | "restore",
    harness: HarnessId,
    snapshotRuntimeVersion = COMPATIBLE_RUNTIME_VERSION
  ) {
    const session = createMockSession({ harness });
    const sandbox = createMockSandbox({
      status: kind === "spawn" ? "pending" : "stopped",
      snapshot_image_id: kind === "restore" ? "saved-image" : null,
      snapshot_runtime_version: kind === "restore" ? snapshotRuntimeVersion : null,
    });
    const storage = createMockStorage(session, sandbox);
    const provider = createMockProvider();
    const recordMcpServers = vi.fn();
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      {
        ...createTestConfig(),
        mcpServerLookup: { getForLaunch: async () => [personal, service] },
        recordMcpServers,
      }
    );

    await manager.spawnSandbox();

    const launched =
      kind === "spawn"
        ? vi.mocked(provider.createSandbox).mock.calls[0][0]
        : vi.mocked(provider.restoreFromSnapshot!).mock.calls[0][0];
    expect(recordMcpServers).toHaveBeenCalledOnce();
    const [recorded, withheld] = recordMcpServers.mock.calls[0];
    return {
      sent: launched.mcpServers?.map((server) => server.name),
      recorded: recorded.map((server: { name: string }) => server.name),
      withheld,
    };
  }

  it("keeps them out of a Codex sandbox and records why", async () => {
    await expect(launch("spawn", "codex")).resolves.toEqual({
      sent: ["docs"],
      recorded: ["tracker", "docs"],
      withheld: "mcp_harness_unsupported",
    });
  });

  it("keeps them out of a sandbox restored from an older runtime", async () => {
    await expect(launch("restore", "opencode", "v79-earlier")).resolves.toEqual({
      sent: ["docs"],
      recorded: ["tracker", "docs"],
      withheld: "mcp_runtime_outdated",
    });
  });

  it.each(["spawn", "restore"] as const)("sends them to a current OpenCode %s", async (kind) => {
    await expect(launch(kind, "opencode")).resolves.toEqual({
      sent: ["tracker", "docs"],
      recorded: ["tracker", "docs"],
      withheld: null,
    });
  });
});

describe("pinned MCP selection at launch", () => {
  const servers: McpServerConfig[] = [
    {
      id: "docs-id",
      name: "docs",
      type: "remote",
      url: "https://docs.example.com/mcp",
      enabled: true,
      authMode: "none",
    },
    {
      id: "tracker-id",
      name: "tracker",
      type: "remote",
      url: "https://tracker.example.com/mcp",
      enabled: true,
      authMode: "none",
    },
  ];

  async function launch(kind: "spawn" | "restore", mcpSelection: string | null) {
    const session = createMockSession({ harness: "opencode", mcp_selection: mcpSelection });
    const sandbox = createMockSandbox({
      status: kind === "spawn" ? "pending" : "stopped",
      snapshot_image_id: kind === "restore" ? "saved-image" : null,
      snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
    });
    const storage = createMockStorage(session, sandbox);
    const provider = createMockProvider();
    const getForLaunch = vi.fn(
      async (_repositories: unknown, selectedIds?: readonly string[] | null) =>
        selectedIds ? servers.filter((server) => selectedIds.includes(server.id)) : servers
    );
    const recordWarning = vi.fn();
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      {
        ...createTestConfig(),
        mcpServerLookup: { getForLaunch },
        recordMcpServers: vi.fn(),
        recordWarning,
      }
    );

    await manager.spawnSandbox();

    const launched =
      kind === "spawn"
        ? vi.mocked(provider.createSandbox).mock.calls[0][0]
        : vi.mocked(provider.restoreFromSnapshot!).mock.calls[0][0];
    return {
      sent: launched.mcpServers?.map((server) => server.name),
      selectedIds: getForLaunch.mock.calls[0][1],
      warnings: recordWarning.mock.calls.filter(([, , target]) => target?.scope === "mcp"),
    };
  }

  it.each(["spawn", "restore"] as const)(
    "runs every server in scope when the session pinned none (%s)",
    async (kind) => {
      const result = await launch(kind, null);
      expect(result.sent).toEqual(["docs", "tracker"]);
      expect(result.selectedIds).toBeNull();
      expect(result.warnings).toEqual([]);
    }
  );

  it.each(["spawn", "restore"] as const)(
    "re-applies the pinned selection and warns once about servers it left out (%s)",
    async (kind) => {
      const result = await launch(
        kind,
        JSON.stringify([
          { id: "docs-id", name: "docs" },
          { id: "deleted-id", name: "old-crm" },
        ])
      );
      expect(result.sent).toEqual(["docs"]);
      expect(result.selectedIds).toEqual(["docs-id", "deleted-id"]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0][0]).toContain("Selected MCP server old-crm is disabled, deleted");
    }
  );

  it("launches no MCP server for an empty selection", async () => {
    const result = await launch("spawn", "[]");
    expect(result.sent).toBeUndefined();
    expect(result.selectedIds).toEqual([]);
  });

  it("fails closed to no server when the stored pin is unreadable", async () => {
    const result = await launch("spawn", "not json");
    expect(result.selectedIds).toEqual([]);
    expect(result.sent).toBeUndefined();
  });
});
