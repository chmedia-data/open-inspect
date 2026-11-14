import { describe, expect, it } from "vitest";
import {
  MAX_MCP_SELECTION_SERVERS,
  mcpServerIdsSchema,
  sessionMcpSelectionSchema,
} from "./managed-mcp";

describe("sessionMcpSelectionSchema", () => {
  it("accepts all, and a selection of unique ids including none", () => {
    expect(sessionMcpSelectionSchema.parse({ mode: "all" })).toEqual({ mode: "all" });
    expect(sessionMcpSelectionSchema.parse({ mode: "selected", serverIds: [] })).toEqual({
      mode: "selected",
      serverIds: [],
    });
    expect(
      sessionMcpSelectionSchema.parse({ mode: "selected", serverIds: ["a1", "b2"] }).mode
    ).toBe("selected");
  });

  it("refuses duplicates, empty ids, too many ids, and unknown modes or fields", () => {
    const tooMany = Array.from({ length: MAX_MCP_SELECTION_SERVERS + 1 }, (_, i) => `s${i}`);
    for (const value of [
      { mode: "selected", serverIds: ["a", "a"] },
      { mode: "selected", serverIds: [""] },
      { mode: "selected", serverIds: tooMany },
      { mode: "selected" },
      { mode: "none" },
      { mode: "all", serverIds: ["a"] },
    ]) {
      expect(sessionMcpSelectionSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("mcpServerIdsSchema", () => {
  it("accepts up to the limit of unique ids", () => {
    const ids = Array.from({ length: MAX_MCP_SELECTION_SERVERS }, (_, i) => `s${i}`);
    expect(mcpServerIdsSchema.parse(ids)).toEqual(ids);
    expect(mcpServerIdsSchema.safeParse([...ids, "extra"]).success).toBe(false);
  });
});
