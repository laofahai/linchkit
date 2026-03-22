/**
 * Environment variable substitution utility
 *
 * Recursively walks a config object and replaces `$env.VAR_NAME` strings
 * with the corresponding `process.env.VAR_NAME` value.
 */

import type { Logger } from "../types/logger";
import { consoleLogger } from "../engine/console-logger";

const ENV_PATTERN = /^\$env\.(.+)$/;

/**
 * Resolve `$env.VAR_NAME` placeholders in a config object.
 *
 * - Only exact-match string values are substituted (no partial interpolation).
 * - Missing env vars produce a warning and resolve to `undefined`.
 * - Non-object values pass through unchanged.
 */
export function resolveEnvVars<T>(config: T, logger: Logger = consoleLogger): T {
  if (config === null || config === undefined) {
    return config;
  }

  if (typeof config === "string") {
    const match = config.match(ENV_PATTERN);
    if (match) {
      const varName = match[1] as string;
      const value = process.env[varName];
      if (value === undefined) {
        logger.warn(
          `Environment variable "${varName}" is not set (referenced as "$env.${varName}")`,
        );
      }
      return value as unknown as T;
    }
    return config;
  }

  if (Array.isArray(config)) {
    return config.map((item) => resolveEnvVars(item, logger)) as unknown as T;
  }

  if (typeof config === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      result[key] = resolveEnvVars(value, logger);
    }
    return result as T;
  }

  return config;
}
