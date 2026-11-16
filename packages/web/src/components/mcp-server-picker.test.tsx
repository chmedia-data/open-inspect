// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import { McpServerPicker, mcpPickerServers } from "./mcp-server-picker";

expect.extend(matchers);
afterEach(cleanup);

function server(overrides: Partial<McpServerMetadata>): McpServerMetadata {
  return {
    id: "s",
    revision: 1,
    name: "s",
    type: "remote",
    hasEnv: false,
    hasHeaders: false,
    enabled: true,
    authMode: "none",
    repoScopes: null,
    ...overrides,
  };
}

const docs = server({ id: "docs", name: "docs" });
const tracker = server({ id: "tracker", name: "tracker", authMode: "user_oauth" });
const scoped = server({ id: "scoped", name: "scoped", repoScopes: ["Acme/Web"] });
const off = server({ id: "off", name: "off", enabled: false });

describe("mcpPickerServers", () => {
  it("offers enabled servers in scope, and keeps selected ones so they can be cleared", () => {
    const all = [docs, tracker, scoped, off];
    expect(mcpPickerServers(all, [], []).map((s) => s.id)).toEqual(["docs", "tracker"]);
    expect(mcpPickerServers(all, ["acme/web"], []).map((s) => s.id)).toEqual([
      "docs",
      "tracker",
      "scoped",
    ]);
    expect(mcpPickerServers(all, [], ["off"]).map((s) => s.id)).toEqual(["docs", "tracker", "off"]);
  });
});

describe("McpServerPicker", () => {
  it("adds and removes servers", async () => {
    const onChange = vi.fn();
    render(
      <McpServerPicker
        servers={[docs, tracker]}
        connectionStatus={new Map([["tracker", "connected"]])}
        value={["docs"]}
        onChange={onChange}
      />
    );
    expect(screen.getByText("personal · connected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: /tracker/ }));
    expect(onChange).toHaveBeenLastCalledWith(["docs", "tracker"]);
    await userEvent.click(screen.getByRole("checkbox", { name: /docs/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("blocks adding a personal server with a reason, but lets a selected one be cleared", () => {
    const reason = "Only scheduled automations can use personal servers.";
    const { rerender } = render(
      <McpServerPicker
        servers={[docs, tracker]}
        connectionStatus={new Map()}
        value={[]}
        onChange={() => {}}
        personalDisabledReason={reason}
      />
    );
    expect(screen.getByRole("checkbox", { name: /tracker/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /docs/ })).toBeEnabled();
    expect(screen.getByText(reason)).toBeInTheDocument();

    rerender(
      <McpServerPicker
        servers={[docs, tracker]}
        connectionStatus={new Map()}
        value={["tracker"]}
        onChange={() => {}}
        personalDisabledReason={reason}
      />
    );
    expect(screen.getByRole("checkbox", { name: /tracker/ })).toBeEnabled();
  });

  it("switches between every server in scope and an explicit list", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <McpServerPicker
        servers={[docs, tracker]}
        connectionStatus={new Map()}
        value={null}
        onChange={onChange}
        allowAll
      />
    );
    expect(screen.getByRole("checkbox", { name: /docs/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "All servers in scope" }));
    expect(onChange).toHaveBeenLastCalledWith(["docs", "tracker"]);

    rerender(
      <McpServerPicker
        servers={[docs, tracker]}
        connectionStatus={new Map()}
        value={[]}
        onChange={onChange}
        allowAll
      />
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "All servers in scope" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
