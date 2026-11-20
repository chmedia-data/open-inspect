import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, type ModelCategory } from "@open-inspect/shared/models";
import { filterModelOptionsForHarness, resolveHarnessModelSelection } from "./session-harness";

const NON_CODEX_MODEL = "xai/grok-4.6";
const options: ModelCategory[] = [
  { category: "Anthropic", models: [{ id: DEFAULT_MODEL, name: "Default", description: "" }] },
  { category: "xAI", models: [{ id: NON_CODEX_MODEL, name: "Grok 4.6", description: "" }] },
];

describe("filterModelOptionsForHarness", () => {
  it("drops groups the harness empties", () => {
    expect(filterModelOptionsForHarness("claude", options)).toEqual([options[0]]);
    expect(filterModelOptionsForHarness("opencode", options)).toEqual(options);
  });
});

describe("resolveHarnessModelSelection", () => {
  it("holds submission while the enabled set loads and keeps the preference for display", () => {
    const selection = resolveHarnessModelSelection({
      harness: "claude",
      preference: { model: NON_CODEX_MODEL },
      enabledModels: [],
      enabledModelOptions: [],
      loading: true,
    });
    expect(selection.availability).toEqual({ status: "loading" });
    expect(selection.model).toBe(NON_CODEX_MODEL);
  });

  it("resolves a preference the harness cannot run to an enabled model it can", () => {
    const selection = resolveHarnessModelSelection({
      harness: "claude",
      preference: { model: NON_CODEX_MODEL },
      enabledModels: [NON_CODEX_MODEL, DEFAULT_MODEL],
      enabledModelOptions: options,
      loading: false,
    });
    expect(selection.availability).toEqual({ status: "available" });
    expect(selection.model).toBe(DEFAULT_MODEL);
    expect(selection.options).toEqual([options[0]]);
  });

  it("reports an empty compatible set instead of falling back to a hidden model", () => {
    const selection = resolveHarnessModelSelection({
      harness: "claude",
      preference: { model: NON_CODEX_MODEL },
      enabledModels: [NON_CODEX_MODEL],
      enabledModelOptions: [options[1]],
      loading: false,
    });
    expect(selection.availability).toEqual({
      status: "unavailable",
      message: "No enabled models can run on Claude Agent.",
    });
    expect(selection.options).toEqual([]);
  });
});

describe("Codex model selection", () => {
  it("shows only catalog-qualified models from the enabled picker options", () => {
    const native: ModelCategory = {
      category: "OpenAI",
      models: [
        { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", description: "" },
        ...options[1].models,
      ],
    };
    expect(filterModelOptionsForHarness("codex", [options[0], native])).toEqual([
      { ...native, models: [native.models[0]] },
    ]);
  });
  const request = {
    harness: "codex" as const,
    preference: { model: "openai/gpt-6.2-astra", reasoningEffort: "max" },
    enabledModels: ["openai/gpt-6.2-astra"],
    enabledModelOptions: [],
    loading: false,
  };
  it("keeps the native max selection", () => {
    expect(resolveHarnessModelSelection(request)).toMatchObject({
      availability: { status: "available" },
      reasoningEffort: "max",
    });
  });
  it("never substitutes an unsupported enabled model", () => {
    expect(
      resolveHarnessModelSelection({
        ...request,
        enabledModels: ["xai/grok-4.6"],
      }).availability.status
    ).toBe("unavailable");
  });
});
