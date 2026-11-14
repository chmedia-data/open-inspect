// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SessionMcpSelectionView } from "@open-inspect/shared/types/integrations";
import { McpServersSection } from "./mcp-servers-section";

expect.extend(matchers);
afterEach(cleanup);

const state = vi.hoisted(() => ({ selection: undefined as SessionMcpSelectionView | undefined }));
vi.mock("@/hooks/use-mcp-servers", () => ({
  useSessionMcpServers: () => ({ selection: state.selection, loading: false, error: undefined }),
}));

describe("McpServersSection", () => {
  it("lists the pinned servers and marks ones no longer available", async () => {
    state.selection = {
      mode: "selected",
      servers: [
        { id: "a", name: "docs", authMode: "none", available: true },
        { id: "b", name: "tracker", authMode: "user_oauth", available: true },
        { id: "c", name: "gone", authMode: null, available: false },
      ],
    };
    render(<McpServersSection sessionId="ses_1" />);
    await userEvent.click(screen.getByText("MCP servers (2)"));
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.getByText("personal")).toBeInTheDocument();
    expect(screen.getByText("no longer available")).toBeInTheDocument();
  });

  it("says when a session runs no server", async () => {
    state.selection = { mode: "selected", servers: [] };
    render(<McpServersSection sessionId="ses_1" />);
    await userEvent.click(screen.getByText("MCP servers (0)"));
    expect(screen.getByText("No MCP servers run in this session.")).toBeInTheDocument();
  });
});
