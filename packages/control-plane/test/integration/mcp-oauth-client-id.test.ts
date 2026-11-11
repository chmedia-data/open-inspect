/**
 * A personal-OAuth MCP server may name a pre-registered client, for authorization servers without
 * dynamic client registration. Against real D1: the client ID is stored with the OAuth profile,
 * changing it invalidates existing connections through the auth revision, and the resolved
 * client records the scope it requests.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpConnectionStore } from "../../src/db/mcp-connections";
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

  it("records the requested scope on the resolved client", async () => {
    const server = await createServer("fixed-client");
    const store = new McpConnectionStore(env.DB, env.TOKEN_ENCRYPTION_KEY!);
    const client = {
      server_id: server.id,
      auth_revision: server.authRevision,
      issuer: ORIGIN,
      resource: `${ORIGIN}/mcp`,
      client_id: "fixed-client",
      redirect_uri: "https://app.test.local/api/mcp-connections/oauth/callback",
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      scope: "session:role:READER",
    };
    await store.saveClient(client);
    expect(await store.getClient(server.id)).toMatchObject({ scope: "session:role:READER" });

    await store.saveClient({ ...client, scope: "" });
    expect(await store.getClient(server.id)).toMatchObject({ scope: "" });
  });
});
