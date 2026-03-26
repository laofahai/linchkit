/**
 * linch search <query> — Search for capabilities in the local registry
 *
 * Searches the local capability-registry.json by keyword, type, and category.
 * Displays matching capabilities with their trust level and version.
 */

import type { TrustLevel } from "@linchkit/core";
import { defineCommand } from "citty";
import { loadLocalRegistry } from "../utils/local-registry-io";

const TRUST_ICONS: Record<TrustLevel, string> = {
  official: "[official]",
  verified: "[verified]",
  community: "[community]",
  unverified: "[unverified]",
};

export const searchCommand = defineCommand({
  meta: {
    name: "search",
    description: "Search for capabilities in the local registry",
  },
  args: {
    query: {
      type: "positional",
      description: "Search keyword (matches name, label, description)",
      required: false,
    },
    type: {
      type: "string",
      description: "Filter by capability type: standard | adapter | bridge",
    },
    category: {
      type: "string",
      description: "Filter by category: business | system | infrastructure | integration | ui | utility",
    },
    "trust-level": {
      type: "string",
      description: "Filter by trust level: official | verified | community | unverified",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  run({ args }) {
    const registry = loadLocalRegistry(process.cwd());

    if (registry.size === 0) {
      console.log("[linch] No capabilities registered. Install some with 'linch install'.");
      return;
    }

    const results = registry.search({
      query: (args.query as string) || undefined,
      type: (args.type as "standard" | "adapter" | "bridge") || undefined,
      category: (args.category as string) || undefined,
      trustLevel: (args["trust-level"] as TrustLevel) || undefined,
    });

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log("[linch] No capabilities found matching your search.");
      return;
    }

    console.log(`\n  Found ${results.length} capability(ies):\n`);

    const maxNameLen = Math.max(...results.map((r) => r.name.length), 4);

    const header = `  ${"Name".padEnd(maxNameLen)}  ${"Version".padEnd(8)}  ${"Type".padEnd(10)}  ${"Trust".padEnd(12)}  Description`;
    console.log(header);
    console.log(
      `  ${"─".repeat(maxNameLen)}  ${"─".repeat(8)}  ${"─".repeat(10)}  ${"─".repeat(12)}  ${"─".repeat(30)}`,
    );

    for (const entry of results) {
      const trust = TRUST_ICONS[entry.trustLevel] || entry.trustLevel;
      const desc = entry.description
        ? entry.description.length > 40
          ? `${entry.description.slice(0, 37)}...`
          : entry.description
        : "";
      console.log(
        `  ${entry.name.padEnd(maxNameLen)}  ${entry.version.padEnd(8)}  ${entry.type.padEnd(10)}  ${trust.padEnd(12)}  ${desc}`,
      );
    }

    console.log("");
  },
});
