/**
 * The deployment's default model: what a session, prompt, automation or child
 * spawn runs on when it names no model. `DEFAULT_MODEL` picks it; unset, it is
 * the catalog's `default: true` entry. Every control-plane fallback reads it
 * through `resolveDefaultModel`, never the shared constant directly.
 */

import {
  DEFAULT_MODEL as CATALOG_DEFAULT_MODEL,
  isValidModel,
  normalizeModelId,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { Logger } from "./logger";
import type { EnvConfig } from "./types";

/**
 * `DEFAULT_MODEL` as a canonical catalog id, or the catalog default when unset.
 * Throws on an id the catalog does not know, so a typo fails the boot (Node)
 * or the first request (Workers) instead of silently running another model.
 */
export function resolveDefaultModel(env: Pick<EnvConfig, "DEFAULT_MODEL">): ValidModel {
  const configured = env.DEFAULT_MODEL?.trim();
  if (!configured) return CATALOG_DEFAULT_MODEL;
  if (!isValidModel(configured)) {
    throw new Error(
      `DEFAULT_MODEL "${configured}" is not a model in the catalog (packages/shared/src/models.ts)`
    );
  }
  return normalizeModelId(configured) as ValidModel;
}

/**
 * Warn when the default is not enabled under Settings › Models. It stays the
 * default: enablement is runtime state an admin may fix at any time, and a
 * deployment should not refuse to boot over it. Returns whether it warned.
 */
export function warnIfDefaultModelDisabled(
  defaultModel: ValidModel,
  enabledModels: readonly ValidModel[],
  log: Pick<Logger, "warn">
): boolean {
  if (enabledModels.includes(defaultModel)) return false;
  log.warn("default_model.not_enabled", {
    event: "default_model.not_enabled",
    default_model: defaultModel,
  });
  return true;
}
