import { describe, expect, it } from "vitest";
import { getReasoningConfig } from "@open-inspect/shared/models";
import { resolveModelPreference } from "./model-selection";
import { resolveHarnessModelSelection } from "./session-harness";

const MODEL = "openai/gpt-6.2-astra";

describe("harness-aware reasoning preference", () => {
  it("keeps an effort the harness supports", () => {
    expect(
      resolveModelPreference({ model: MODEL, reasoningEffort: "max" }, undefined, "codex")
        .reasoningEffort
    ).toBe("max");
  });

  it("replaces an effort only the generic catalog offers with the harness default", () => {
    expect(getReasoningConfig("openai/gpt-6-sol")?.efforts).toContain("none");
    expect(
      resolveModelPreference(
        { model: "openai/gpt-6-sol", reasoningEffort: "none" },
        undefined,
        "codex"
      ).reasoningEffort
    ).toBe("medium");
  });

  it("carries the Codex selection through the composer's model selection", () => {
    const selection = resolveHarnessModelSelection({
      harness: "codex",
      preference: { model: MODEL, reasoningEffort: "max" },
      enabledModels: [MODEL],
      enabledModelOptions: [],
      loading: false,
    });
    expect(selection.availability).toEqual({ status: "available" });
    expect(selection).toMatchObject({ model: MODEL, reasoningEffort: "max" });
  });
});
