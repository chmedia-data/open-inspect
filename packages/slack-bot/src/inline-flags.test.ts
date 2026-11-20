import { describe, expect, it } from "vitest";
import type { ValidModel } from "@open-inspect/shared/models";
import {
  normalizeModelSelection,
  resolveInlinePromptOptions,
  sessionLaunchPlanSchema,
} from "./inline-flags";

describe("resolveInlinePromptOptions", () => {
  const defaults = { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" };
  const enabledModels = [
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-6.2-astra",
  ] satisfies ValidModel[];
  const sessionDefaults = {
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "high",
  };

  it("resolves combined overrides against the inline model", () => {
    expect(
      resolveInlinePromptOptions(
        { model: "openai/gpt-6.2-astra", reasoningEffort: "xhigh" },
        defaults,
        enabledModels
      )
    ).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults,
        promptOverrides: { model: "openai/gpt-6.2-astra", reasoningEffort: "xhigh" },
        effective: { model: "openai/gpt-6.2-astra", reasoningEffort: "xhigh" },
      },
    });
  });

  it("normalizes bare model ids and preserves a compatible default effort", () => {
    expect(resolveInlinePromptOptions({ model: "gpt-6.2-astra" }, defaults, enabledModels)).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults,
        promptOverrides: { model: "openai/gpt-6.2-astra", reasoningEffort: "high" },
        effective: { model: "openai/gpt-6.2-astra", reasoningEffort: "high" },
      },
    });
  });

  it("keeps a disabled session model when applying a reasoning override", () => {
    expect(
      resolveInlinePromptOptions(
        { reasoningEffort: "high" },
        { model: "openai/gpt-6.2-astra", reasoningEffort: "xhigh" },
        ["anthropic/claude-sonnet-4-6"]
      )
    ).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults: { model: "openai/gpt-6.2-astra", reasoningEffort: "xhigh" },
        promptOverrides: { reasoningEffort: "high" },
        effective: { model: "openai/gpt-6.2-astra", reasoningEffort: "high" },
      },
    });
  });

  it("rejects disabled models and incompatible reasoning", () => {
    expect(
      resolveInlinePromptOptions({ model: "openai/gpt-6.2-sol" }, defaults, enabledModels)
    ).toEqual({ ok: false, error: 'Model "openai/gpt-6.2-sol" is not enabled.' });
    expect(resolveInlinePromptOptions({ reasoningEffort: "max" }, defaults, enabledModels)).toEqual(
      {
        ok: true,
        turnPlan: {
          sessionDefaults,
          promptOverrides: { reasoningEffort: "max" },
          effective: { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "max" },
        },
      }
    );
    expect(
      resolveInlinePromptOptions(
        { model: "openai/gpt-6.2-astra", reasoningEffort: "none" },
        defaults,
        enabledModels
      )
    ).toEqual({
      ok: false,
      error:
        'Reasoning effort "none" is not valid for "openai/gpt-6.2-astra". Supported values: low, medium, high, xhigh, max.',
    });
  });

  it("escapes Slack control tokens in validation errors", () => {
    expect(resolveInlinePromptOptions({ model: "<!channel>" }, defaults, enabledModels)).toEqual({
      ok: false,
      error: 'Unknown model "&lt;!channel&gt;".',
    });
    expect(
      resolveInlinePromptOptions({ reasoningEffort: "<@U123>" }, defaults, enabledModels)
    ).toEqual({
      ok: false,
      error:
        'Reasoning effort "&lt;@U123&gt;" is not valid for "anthropic/claude-sonnet-4-6". Supported values: low, medium, high, max.',
    });
  });
});

describe("normalizeModelSelection", () => {
  it("parses valid stored reasoning efforts and falls back for malformed values", () => {
    expect(
      normalizeModelSelection({ model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" })
    ).toEqual({ model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" });
    expect(
      normalizeModelSelection({ model: "anthropic/claude-sonnet-4-6", reasoningEffort: "ultra" })
    ).toEqual({ model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" });
  });
});

describe("sessionLaunchPlanSchema", () => {
  it("drops an opening-prompt override saved before overrides were removed", () => {
    expect(
      sessionLaunchPlanSchema.parse({
        sessionDefaults: { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
        promptOverrides: { model: "openai/gpt-6.1-terra" },
      })
    ).toEqual({
      sessionDefaults: { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
    });
  });
});
