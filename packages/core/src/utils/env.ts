/**
 * Environment variable substitution utility
 *
 * Recursively walks a config object and replaces `$env.VAR_NAME` strings
 * with the corresponding `process.env.VAR_NAME` value.
 */

import { consoleLogger } from "../observability/console-logger";
import type { Logger } from "../types/logger";

const ENV_PATTERN = /^\$env\.(.+)$/;

/**
 * True only for plain objects (literal `{}` / `Object.create(null)`).
 *
 * Class instances (e.g. graphql-js `GraphQLNonNull` / `GraphQLObjectType`
 * carried in `extensions.graphqlExtensions`) must NOT be rebuilt, or their
 * prototype is lost and graphql treats them as unnamed types at schema build
 * time. `$env.*` placeholders only ever live in plain config data, so it is
 * safe to recurse into plain objects exclusively and pass instances through.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Resolve `$env.VAR_NAME` placeholders in a config object.
 *
 * - Only exact-match string values are substituted (no partial interpolation).
 * - Missing env vars produce a warning and resolve to `undefined`.
 * - Non-object values pass through unchanged.
 * - Class instances pass through by reference (prototype preserved).
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

  // Only recurse into plain objects. Class instances (graphql types, Date,
  // Map, etc.) pass through by reference so their prototype is preserved.
  if (typeof config === "object" && isPlainObject(config as object)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      result[key] = resolveEnvVars(value, logger);
    }
    return result as T;
  }

  return config;
}
