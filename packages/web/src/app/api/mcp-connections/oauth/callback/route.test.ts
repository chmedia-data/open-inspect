import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MCP_OAUTH_LOOPBACK_REDIRECT_URI } from "@open-inspect/shared/types/integrations";
import { GET, POST } from "./route";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: fetcher }));
afterEach(() => vi.resetAllMocks());
it("redeems only through browser-auth forwarding and removes callback secrets from navigation", async () => {
  fetcher.mockResolvedValue(new Response("{}"));
  const response = await GET(
    new NextRequest(
      "https://app.example/api/mcp-connections/oauth/callback?code=private-code&state=private-state&iss=https%3A%2F%2Fissuer.example&returnTo=https%3A%2F%2Fevil.example"
    )
  );
  expect(fetcher).toHaveBeenCalledWith("/mcp-connections/oauth/callback", {
    method: "POST",
    body: JSON.stringify({
      code: "private-code",
      state: "private-state",
      iss: "https://issuer.example",
    }),
  });
  expect(response.headers.get("location")).toBe(
    "https://app.example/settings?tab=mcp-connections&mcp=connected"
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("provider denial remains sanitized and never redeems a missing code", async () => {
  const response = await GET(
    new NextRequest(
      "https://app.example/api/mcp-connections/oauth/callback?error=access_denied&error_description=private-details"
    )
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(response.headers.get("location")).toBe(
    "https://app.example/settings?tab=mcp-connections&mcp=reconnect_required"
  );
});
function paste(url: unknown) {
  return POST(
    new NextRequest("https://app.example/api/mcp-connections/oauth/callback", {
      method: "POST",
      body: JSON.stringify({ url }),
    })
  );
}
it("redeems a pasted loopback redirect URL", async () => {
  fetcher.mockResolvedValue(new Response("{}"));
  const response = await paste(
    ` ${MCP_OAUTH_LOOPBACK_REDIRECT_URI}?code=private-code&state=private-state&iss=https%3A%2F%2Fissuer.example `
  );
  expect(fetcher).toHaveBeenCalledWith("/mcp-connections/oauth/callback", {
    method: "POST",
    body: JSON.stringify({
      code: "private-code",
      state: "private-state",
      iss: "https://issuer.example",
    }),
  });
  expect(await response.json()).toEqual({ status: "connected" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("reports reconnect_required when the control plane refuses the pasted code", async () => {
  fetcher.mockResolvedValue(new Response("{}", { status: 403 }));
  const response = await paste(`${MCP_OAUTH_LOOPBACK_REDIRECT_URI}?code=c&state=s`);
  expect(await response.json()).toEqual({ status: "reconnect_required" });
});
it("maps a pasted provider error to reconnect_required without redeeming", async () => {
  const response = await paste(
    `${MCP_OAUTH_LOOPBACK_REDIRECT_URI}?error=access_denied&error_description=private-details`
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "reconnect_required" });
});
it.each([
  ["not a URL", "code=c&state=s"],
  ["a non-string", 42],
  ["another scheme", "https://localhost:33418/callback?code=c&state=s"],
  ["another host", "http://127.0.0.1:33418/callback?code=c&state=s"],
  ["another port", "http://localhost:33419/callback?code=c&state=s"],
  ["another path", "http://localhost:33418/other?code=c&state=s"],
  ["a missing code", "http://localhost:33418/callback?state=s"],
  ["a missing state", "http://localhost:33418/callback?code=c"],
])("rejects %s without redeeming", async (_label, url) => {
  const response = await paste(url);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_redirect_url" });
  expect(fetcher).not.toHaveBeenCalled();
});
