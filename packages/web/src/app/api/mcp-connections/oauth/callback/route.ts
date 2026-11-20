import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { MCP_OAUTH_LOOPBACK_REDIRECT_URI } from "@open-inspect/shared/types/integrations";
import { controlPlaneUserFetch } from "@/lib/control-plane";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/** Forwards a provider redirect's code/state/iss; any failure means the user reconnects. */
async function redeem(params: URLSearchParams): Promise<boolean> {
  try {
    const code = params.get("code"),
      state = params.get("state"),
      iss = params.get("iss");
    if (!code || !state || params.has("error")) return false;
    const response = await controlPlaneUserFetch("/mcp-connections/oauth/callback", {
      method: "POST",
      body: JSON.stringify({ code, state, ...(iss ? { iss } : {}) }),
    });
    return response.ok;
  } catch {
    /* Never log authorization codes, state, or provider error descriptions. */
    return false;
  }
}

export async function GET(request: NextRequest) {
  const destination = new URL("/settings?tab=mcp-connections", request.url);
  const connected = await redeem(request.nextUrl.searchParams);
  destination.searchParams.set("mcp", connected ? "connected" : "reconnect_required");
  return NextResponse.redirect(destination, { status: 303, headers: NO_STORE });
}

/** Paste-back for loopback servers: the body carries the full URL the provider redirected to. */
export async function POST(request: NextRequest) {
  let pasted: URL;
  try {
    const { url } = (await request.json()) as { url?: unknown };
    pasted = new URL(typeof url === "string" ? url.trim() : "");
  } catch {
    return NextResponse.json({ error: "invalid_redirect_url" }, { status: 400, headers: NO_STORE });
  }
  const expected = new URL(MCP_OAUTH_LOOPBACK_REDIRECT_URI);
  const params = pasted.searchParams;
  if (
    pasted.origin !== expected.origin ||
    pasted.pathname !== expected.pathname ||
    (!params.has("error") && (!params.get("code") || !params.get("state")))
  )
    return NextResponse.json({ error: "invalid_redirect_url" }, { status: 400, headers: NO_STORE });
  const connected = await redeem(params);
  return NextResponse.json(
    { status: connected ? "connected" : "reconnect_required" },
    { headers: NO_STORE }
  );
}
