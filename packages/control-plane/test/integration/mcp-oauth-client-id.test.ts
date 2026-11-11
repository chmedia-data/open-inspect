/**
 * A personal-OAuth MCP server may name a pre-registered client, for authorization servers without
 * dynamic client registration. Against real D1: the client ID is stored with the OAuth profile,
 * and changing it or the pinned scopes invalidates existing connections through the auth revision.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServerStore } from "../../src/db/mcp-servers";
import { cleanD1Tables } from "./cleanup";

const ORIGIN = "https://mcp.fixture.test";

function registry() {
  return new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
}

async function createServer(clientId?: string) {
  return registry().create({
    name: "snowflake",
    type: "remote",
    url: `${ORIGIN}/mcp`,
    enabled: true,
    managedRouting: true,
    authMode: "user_oauth",
    oauth: { issuer: ORIGIN, resource: `${ORIGIN}/mcp`, ...(clientId ? { clientId } : {}) },
  });
}

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

describe("pre-registered MCP OAuth clients", () => {
  it("stores the client ID with the OAuth profile", async () => {
    const server = await createServer("fixed-client");
    expect((await registry().get(server.id))?.oauth).toEqual({
      issuer: ORIGIN,
      resource: `${ORIGIN}/mcp`,
      clientId: "fixed-client",
    });
  });

  it("bumps the auth revision when the client ID changes, and only then", async () => {
    const server = await createServer("fixed-client");
    const profile = (clientId?: string) => ({
      oauth: { issuer: ORIGIN, resource: `${ORIGIN}/mcp`, ...(clientId ? { clientId } : {}) },
    });

    const same = await registry().update(server.id, profile("fixed-client"));
    expect(same?.authRevision).toBe(server.authRevision);

    const changed = await registry().update(server.id, profile("other-client"));
    expect(changed?.authRevision).toBe(server.authRevision + 1);

    const removed = await registry().update(server.id, profile());
    expect(removed?.authRevision).toBe(server.authRevision + 2);
  });

  it("bumps the auth revision when the pinned scopes change", async () => {
    const server = await createServer("fixed-client");
    const profile = (scopes?: string[]) => ({
      oauth: {
        issuer: ORIGIN,
        resource: `${ORIGIN}/mcp`,
        clientId: "fixed-client",
        ...(scopes ? { scopes } : {}),
      },
    });
    const pinned = await registry().update(server.id, profile(["session:role:READER"]));
    expect(pinned?.authRevision).toBe(server.authRevision + 1);
    expect(pinned?.oauth?.scopes).toEqual(["session:role:READER"]);
    const same = await registry().update(server.id, profile(["session:role:READER"]));
    expect(same?.authRevision).toBe(server.authRevision + 1);
    const widened = await registry().update(
      server.id,
      profile(["session:role:READER", "refresh_token"])
    );
    expect(widened?.authRevision).toBe(server.authRevision + 2);
  });
});
