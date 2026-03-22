/**
 * Configuration loader — loads linchkit.config.ts from project root.
 *
 * Bun can import TypeScript directly, so no transpilation step is needed.
 * After import, env var placeholders ($env.VAR_NAME) are resolved and
 * defaults are merged.
 */

import { resolve } from "node:path";
import type { LinchKitConfig } from "@linchkit/core";
import { resolveEnvVars } from "@linchkit/core/utils/env";

/** Default configuration values */
const CONFIG_DEFAULTS: LinchKitConfig = {
  server: {
    port: 3001,
    host: "0.0.0.0",
  },
};

/**
 * Deep merge two objects. `source` values override `target` values.
 * Only plain objects are merged recursively; arrays and other types
 * are replaced entirely.
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== undefined &&
      typeof srcVal === "object" &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

export interface LoadConfigOptions {
  /** Project root directory (default: process.cwd()) */
  root?: string;
  /** Config file name (default: "linchkit.config.ts") */
  configFile?: string;
}

/**
 * Load the project configuration from linchkit.config.ts.
 *
 * Steps:
 * 1. Import the config file (Bun handles TS natively)
 * 2. Resolve `$env.VAR_NAME` placeholders
 * 3. Merge with defaults
 * 4. Validate required fields
 */
export async function loadConfig(options?: LoadConfigOptions): Promise<LinchKitConfig> {
  const root = options?.root ?? process.cwd();
  const configFile = options?.configFile ?? "linchkit.config.ts";
  const configPath = resolve(root, configFile);

  let rawConfig: LinchKitConfig;

  try {
    const imported = await import(configPath);
    rawConfig = imported.default ?? imported;
  } catch (err) {
    const error = err as Error;
    if (error.message?.includes("Cannot find module") || error.message?.includes("no such file")) {
      console.warn(`[linchkit] Config file not found at ${configPath}, using defaults.`);
      rawConfig = {};
    } else {
      throw new Error(`[linchkit] Failed to load config from ${configPath}: ${error.message}`);
    }
  }

  // Resolve $env.VAR_NAME placeholders
  const resolved = resolveEnvVars(rawConfig);

  // Merge with defaults (user config takes precedence)
  const config = deepMerge(
    CONFIG_DEFAULTS as Record<string, unknown>,
    resolved as Record<string, unknown>,
  ) as LinchKitConfig;

  // Validate: if AI is configured, ensure at least one provider exists
  if (config.ai) {
    if (!config.ai.providers || Object.keys(config.ai.providers).length === 0) {
      throw new Error("[linchkit] ai.providers must have at least one provider configured.");
    }
    if (!config.ai.defaultProvider) {
      throw new Error("[linchkit] ai.defaultProvider is required when ai is configured.");
    }
    if (!config.ai.providers[config.ai.defaultProvider]) {
      throw new Error(
        `[linchkit] ai.defaultProvider "${config.ai.defaultProvider}" not found in ai.providers.`,
      );
    }
  }

  return config;
}
