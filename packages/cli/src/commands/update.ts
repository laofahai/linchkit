/**
 * linch update <package-name> — Update a capability package to latest version
 *
 * Runs `bun update`, re-reads capability.json, validates metadata,
 * and updates the local registry entry with the new version.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCapabilityMetadata } from "@linchkit/core";
import { defineCommand } from "citty";
import { loadLocalRegistry, saveLocalRegistry } from "../utils/local-registry-io";

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update a capability package to the latest version",
  },
  args: {
    packageName: {
      type: "positional",
      description: "npm package name to update (e.g. @linchkit/cap-auth)",
      required: true,
    },
  },
  async run({ args }) {
    const packageName = args.packageName;

    console.log(`[linch] Updating ${packageName}...`);

    // Step 1: Run bun update
    const result = Bun.spawnSync(["bun", "update", packageName], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode !== 0) {
      console.error(`[linch] Failed to update ${packageName}`);
      process.exit(1);
    }

    console.log(`[linch] Package ${packageName} updated successfully.`);

    // Step 2: Re-read capability.json to update registry
    const capabilityJsonPath = resolve(
      process.cwd(),
      "node_modules",
      packageName,
      "capability.json",
    );

    if (!existsSync(capabilityJsonPath)) {
      console.log("[linch] No capability.json found — skipping registry update.");
      return;
    }

    let raw: unknown;
    try {
      const content = readFileSync(capabilityJsonPath, "utf-8");
      raw = JSON.parse(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[linch] Failed to read capability.json: ${msg}`);
      return;
    }

    const validation = validateCapabilityMetadata(raw);
    if (!validation.success) {
      console.warn("[linch] Updated capability.json validation failed.");
      return;
    }

    const metadata = validation.data;

    // Step 3: Update local registry
    const registry = loadLocalRegistry(process.cwd());
    const existing = registry.get(packageName);

    if (existing) {
      const oldVersion = existing.version;
      existing.version = metadata.version;
      registry.register(existing);
      saveLocalRegistry(process.cwd(), registry);
      console.log(`[linch] Registry updated: ${packageName} ${oldVersion} -> ${metadata.version}`);
    } else {
      console.log("[linch] Capability not in local registry — use 'linch install' to register it.");
    }
  },
});
