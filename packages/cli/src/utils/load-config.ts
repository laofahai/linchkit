/**
 * Load LinchKit project configuration from linchkit.config.ts
 */

import { resolve } from "node:path";
import type { LinchKitConfig } from "@linchkit/core";

export interface LoadConfigResult {
  config: LinchKitConfig;
  configPath: string;
}

/**
 * Load linchkit.config.ts from the given directory.
 * Searches: config/linchkit.config.ts first, then root linchkit.config.ts.
 * Returns the config object and the resolved path.
 *
 * @throws Error if the config file is not found
 */
export async function loadConfig(cwd?: string): Promise<LoadConfigResult> {
  const dir = cwd ?? process.cwd();
  const candidates = [
    resolve(dir, "config/linchkit.config.ts"),
    resolve(dir, "linchkit.config.ts"),
  ];
  // Pick the first candidate that exists on disk, fall back to root
  const { existsSync } = await import("node:fs");
  const configPath = candidates.find((p) => existsSync(p)) ?? (candidates[1] as string);

  try {
    const mod = await import(configPath);
    const config = (mod.default ?? mod) as LinchKitConfig;
    return { config, configPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only treat as "not found" if the config file itself is the missing module,
    // not if a dependency imported by the config is missing.
    const isConfigNotFound =
      (message.includes("Cannot find module") && message.includes(configPath)) ||
      message.includes("no such file");
    if (isConfigNotFound) {
      throw new Error(
        `Config file not found: ${configPath}\n` +
          `Run "linch init" to create a new project, or make sure you're in a LinchKit project directory.`,
      );
    }
    throw new Error(`Failed to load config: ${configPath}\n${message}`);
  }
}
