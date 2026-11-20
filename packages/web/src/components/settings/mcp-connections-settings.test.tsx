// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpConnectionsSettings } from "./mcp-connections-settings";
const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  mutate: vi.fn(),
  status: "connected",
  enabled: false,
  redirect: "web",
}));
vi.mock("swr", () => ({
  default: () => ({
    data: {
      connections: [
        {
          serverId: "example",
          name: "Example",
          enabled: state.enabled,
          authMode: "user_oauth",
          redirect: state.redirect,
          status: state.status,
        },
      ],
    },
    mutate: state.mutate,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: state.fetch }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.status = "connected";
  state.enabled = false;
  state.redirect = "web";
});
it("lets an owner clear an abandoned OAuth reservation even after the server is disabled", async () => {
  state.status = "reconnect_required";
  state.fetch.mockResolvedValue(new Response("{}"));
  render(<McpConnectionsSettings />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(state.mutate).toHaveBeenCalledOnce());
  expect(state.fetch).toHaveBeenCalledWith("/api/mcp-connections/example", { method: "DELETE" });
});
it("allows self-disconnect even after an administrator disables the server", async () => {
  state.fetch.mockResolvedValue(new Response("{}"));
  render(<McpConnectionsSettings />);
  expect((screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(
    true
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(state.mutate).toHaveBeenCalledOnce());
  expect(state.fetch).toHaveBeenCalledWith("/api/mcp-connections/example", { method: "DELETE" });
  expect(screen.getByText(/session outputs remain shared/)).toBeTruthy();
});
it("loopback servers open consent in a new tab and complete from a pasted redirect URL", async () => {
  state.status = "not_connected";
  state.enabled = true;
  state.redirect = "loopback";
  state.fetch
    .mockResolvedValueOnce(
      Response.json({ authorizationUrl: "https://issuer.example/authorize?x=1" })
    )
    .mockResolvedValueOnce(Response.json({ status: "connected" }));
  const user = userEvent.setup();
  render(<McpConnectionsSettings />);
  await user.click(screen.getByRole("button", { name: "Connect" }));
  const link = await screen.findByRole("link", { name: "Open the sign-in page" });
  expect(link.getAttribute("href")).toBe("https://issuer.example/authorize?x=1");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(screen.getByText(/that is expected/)).toBeTruthy();
  const pasted = "http://localhost:33418/callback?code=c&state=s";
  await user.type(screen.getByRole("textbox", { name: "Redirect URL" }), pasted);
  await user.click(screen.getByRole("button", { name: "Complete connection" }));
  await waitFor(() => expect(state.mutate).toHaveBeenCalledOnce());
  expect(state.fetch).toHaveBeenLastCalledWith("/api/mcp-connections/oauth/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: pasted }),
  });
  expect(screen.queryByRole("textbox", { name: "Redirect URL" })).toBeNull();
});
