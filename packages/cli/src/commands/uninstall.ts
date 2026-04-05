/**
 * linch uninstall <package-name> — Remove a capability package
 *
 * Runs `bun remove`, updates the local capability registry, and checks
 * for dependency protection (warns if other capabilities depend on it).
 *
 * Features:
 * - Dependency protection — prevents removing capabilities that others depend on
 * - --force flag to override dependency protection
 * - Updates .linchkit/capability-registry.json
 */

import { defineCommand } from "citty";
import { loadLocalRegistry, saveLocalRegistry } from "../utils/local-registry-io";

export const uninstallCommand = defineCommand({
  meta: {
    name: "uninstall",
    description: "Uninstall a capability package with dependency protection",
  },
  args: {
    packageName: {
      type: "positional",
      description: "npm package name (e.g. @linchkit/cap-auth)",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Force uninstall even if other capabilities depend on it",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Preview what would be uninstalled without actually removing",
      default: false,
    },
  },
  async run({ args }) {
    const packageName = args.packageName;
    const isForce = args.force as boolean;
    const isDryRun = args["dry-run"] as boolean;

    const registry = loadLocalRegistry(process.cwd());

    // Check dependency protection
    const { safe, dependents } = registry.canUninstall(packageName);

    if (!safe && !isForce) {
      console.error(
        `[linch] Cannot uninstall "${packageName}" — the following capabilities depend on it:`,
      );
      for (const dep of dependents) {
        console.error(`  - ${dep}`);
      }
      console.error("");
      console.error("[linch] Use --force to override this check.");
      process.exit(1);
    }

    if (!safe && isForce) {
      console.warn(
        `[linch] Warning: Force-uninstalling "${packageName}" — the following capabilities depend on it:`,
      );
      for (const dep of dependents) {
        console.warn(`  - ${dep}`);
      }
      console.warn("");
    }

    if (isDryRun) {
      console.log("[linch] Dry run mode — no changes will be made.\n");
      console.log(`[linch] Would uninstall: ${packageName}`);
      if (registry.has(packageName)) {
        console.log("[linch] Would remove from local capability registry.");
      }
      return;
    }

    // Step 1: Run bun remove
    console.log(`[linch] Uninstalling ${packageName}...`);

    const result = Bun.spawnSync(["bun", "remove", packageName], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode !== 0) {
      console.error(`[linch] Failed to uninstall ${packageName}`);
      process.exit(1);
    }

    // Step 2: Remove from local registry
    const wasRegistered = registry.unregister(packageName);
    if (wasRegistered) {
      saveLocalRegistry(process.cwd(), registry);
    }

    console.log("");
    console.log(`[linch] Capability "${packageName}" uninstalled successfully.`);
    if (wasRegistered) {
      console.log("[linch] Removed from local capability registry.");
    }
  },
});
