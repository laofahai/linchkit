/**
 * linch registry — Capability registry management
 *
 * Aggregates capability metadata from CapabilityDefinition objects
 * loaded via linchkit.config.ts, enriched with npm metadata from
 * addon package.json files.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand } from "citty";
import { aggregateRegistry } from "../registry";
import { loadConfig } from "../utils/load-config";

/**
 * Load capabilities from linchkit.config.ts.
 * Returns an empty array if no config is found.
 */
async function loadCapabilities(cwd: string) {
  try {
    const { config } = await loadConfig(cwd);
    return config?.capabilities ?? [];
  } catch {
    return [];
  }
}

const registrySyncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Aggregate addon metadata and write docs/capability-registry.json",
  },
  args: {
    root: {
      type: "string",
      description: "Project root directory (defaults to cwd)",
    },
  },
  async run({ args }) {
    const projectRoot = (args.root as string | undefined) ?? process.cwd();
    const capabilities = await loadCapabilities(projectRoot);
    const registry = await aggregateRegistry(projectRoot, capabilities);

    const outputPath = join(projectRoot, "docs", "capability-registry.json");
    const content = JSON.stringify(registry, null, 2);
    await writeFile(outputPath, `${content}\n`, "utf-8");

    console.log(`[linch] Registry synced: ${registry.capabilities.length} capability(ies)`);
    console.log(`[linch] Written to ${outputPath}`);
  },
});

const registryListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all discovered capabilities in a table",
  },
  args: {
    root: {
      type: "string",
      description: "Project root directory (defaults to cwd)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON instead of a table",
      default: false,
    },
  },
  async run({ args }) {
    const projectRoot = (args.root as string | undefined) ?? process.cwd();
    const capabilities = await loadCapabilities(projectRoot);
    const registry = await aggregateRegistry(projectRoot, capabilities);

    if (args.json) {
      console.log(JSON.stringify(registry, null, 2));
      return;
    }

    if (registry.capabilities.length === 0) {
      console.log("[linch] No capabilities found in linchkit.config.ts");
      return;
    }

    // Print table header
    const nameWidth = 36;
    const typeWidth = 10;
    const categoryWidth = 16;
    const versionWidth = 10;

    const header = [
      "Name".padEnd(nameWidth),
      "Type".padEnd(typeWidth),
      "Category".padEnd(categoryWidth),
      "Version".padEnd(versionWidth),
    ].join("  ");

    const separator = [
      "─".repeat(nameWidth),
      "─".repeat(typeWidth),
      "─".repeat(categoryWidth),
      "─".repeat(versionWidth),
    ].join("  ");

    console.log(header);
    console.log(separator);

    for (const cap of registry.capabilities) {
      const row = [
        cap.name.padEnd(nameWidth),
        cap.type.padEnd(typeWidth),
        cap.category.padEnd(categoryWidth),
        cap.version.padEnd(versionWidth),
      ].join("  ");
      console.log(row);
    }

    console.log(`\n${registry.capabilities.length} capability(ies) found`);
  },
});

export const registryCommand = defineCommand({
  meta: {
    name: "registry",
    description: "Capability registry management",
  },
  subCommands: {
    sync: registrySyncCommand,
    list: registryListCommand,
  },
});
