import { describe, expect, it } from "vitest";
import { mcpOAuthProfileSchema } from "./managed-mcp";

const base = { issuer: "https://auth.example.com", resource: "https://mcp.example.com/mcp" };

describe("mcpOAuthProfileSchema", () => {
  it("accepts a pre-registered client and RFC 6749 scope tokens", () => {
    expect(
      mcpOAuthProfileSchema.parse({
        ...base,
        clientId: " fixed-client ",
        scopes: ["session:role:CHM_MCP_READER", "refresh_token"],
      })
    ).toEqual({
      ...base,
      clientId: "fixed-client",
      scopes: ["session:role:CHM_MCP_READER", "refresh_token"],
    });
  });

  it.each([[["two words"]], [['quote"d']], [["back\\slash"]], [[""]], [[]]])(
    "refuses scopes %j",
    (scopes) => {
      expect(mcpOAuthProfileSchema.safeParse({ ...base, scopes }).success).toBe(false);
    }
  );

  it("refuses an empty client ID", () => {
    expect(mcpOAuthProfileSchema.safeParse({ ...base, clientId: "  " }).success).toBe(false);
  });
});
