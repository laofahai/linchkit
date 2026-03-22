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
 * Returns the config object and the resolved path.
 *
 * @throws Error if the config file is not found
 */
export async function loadConfig(cwd?: string): Promise<LoadConfigResult> {
  const dir = cwd ?? process.cwd();
  const configPath = resolve(dir, "linchkit.config.ts");

  try {
    const mod = await import(configPath);
    const config = (mod.default ?? mod) as LinchKitConfig;
    return { config, configPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("no such file")) {
      throw new Error(
        `Config file not found: ${configPath}\n` +
          `Run "linch init" to create a new project, or make sure you're in a LinchKit project directory.`,
      );
    }
    throw new Error(`Failed to load config: ${configPath}\n${message}`);
  }
}
