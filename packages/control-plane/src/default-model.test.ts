import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { resolveDefaultModel, warnIfDefaultModelDisabled } from "./default-model";

describe("resolveDefaultModel", () => {
  it.each([undefined, "", "  "])("keeps the catalog default when DEFAULT_MODEL is %j", (value) => {
    expect(resolveDefaultModel({ DEFAULT_MODEL: value })).toBe(DEFAULT_MODEL);
  });

  it("returns a configured catalog model in canonical form", () => {
    expect(resolveDefaultModel({ DEFAULT_MODEL: "openai/gpt-5.5" })).toBe("openai/gpt-5.5");
    expect(resolveDefaultModel({ DEFAULT_MODEL: " claude-opus-4-8 " })).toBe(
      "anthropic/claude-opus-4-8"
    );
  });

  it("fails on a model the catalog does not know", () => {
    expect(() => resolveDefaultModel({ DEFAULT_MODEL: "acme/not-a-model" })).toThrow(
      'DEFAULT_MODEL "acme/not-a-model" is not a model in the catalog'
    );
  });
});

describe("warnIfDefaultModelDisabled", () => {
  it("warns, and keeps the default, when it is not enabled", () => {
    const log = { warn: vi.fn() };
    expect(warnIfDefaultModelDisabled("openai/gpt-5.5", [DEFAULT_MODEL], log)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith("default_model.not_enabled", {
      event: "default_model.not_enabled",
      default_model: "openai/gpt-5.5",
    });
  });

  it("stays quiet when the default is enabled", () => {
    const log = { warn: vi.fn() };
    expect(warnIfDefaultModelDisabled(DEFAULT_MODEL, [DEFAULT_MODEL], log)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
