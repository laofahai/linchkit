/**
 * linch info — Display current project information
 *
 * Shows registered capabilities, schema/action counts, database status,
 * and other project metadata by loading linchkit.config.ts.
 */

import type { CapabilityDefinition, LinchKitConfig } from "@linchkit/core";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";

export const infoCommand = defineCommand({
  meta: {
    name: "info",
    description: "Show current project info: capabilities, schemas, actions, database status",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const outputJson = args.json as boolean;

    // Load project config
    let config: LinchKitConfig;
    let configPath: string;
    try {
      const result = await loadConfig();
      config = result.config;
      configPath = result.configPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Config file not found")) {
        console.error("[linch] No linchkit.config.ts found. Are you in a LinchKit project directory?");
        console.error("[linch] Run 'linch init' to create a new project.");
      } else {
        console.error(`[linch] Failed to load config: ${msg}`);
      }
      process.exit(1);
    }

    const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];

    // Collect statistics
    let schemaCount = 0;
    let actionCount = 0;
    let viewCount = 0;
    let ruleCount = 0;
    let linkCount = 0;
    let flowCount = 0;
    let stateCount = 0;
    let eventHandlerCount = 0;
    const transportNames: string[] = [];

    for (const cap of capabilities) {
      if (cap.schemas) schemaCount += cap.schemas.length;
      if (cap.actions) actionCount += cap.actions.length;
      if (cap.views) viewCount += cap.views.length;
      if (cap.rules) ruleCount += cap.rules.length;
      if (cap.links) linkCount += cap.links.length;
      if (cap.flows) flowCount += cap.flows.length;
      if (cap.states) stateCount += cap.states.length;
      if (cap.eventHandlers) eventHandlerCount += cap.eventHandlers.length;
      if (cap.extensions?.transports) {
        for (const t of cap.extensions.transports) {
          transportNames.push(t.name);
        }
      }
    }

    // Database status
    const dbUrl = config.database?.url;
    const hasDatabase = !!dbUrl;
    // Mask the connection string for display (show host/db, hide password)
    let dbDisplay = "Not configured (InMemoryStore fallback)";
    if (dbUrl) {
      try {
        // Handle $env.VAR patterns
        if (dbUrl.startsWith("$env.")) {
          const envVar = dbUrl.replace("$env.", "");
          const resolvedUrl = process.env[envVar];
          if (resolvedUrl) {
            dbDisplay = maskDbUrl(resolvedUrl);
          } else {
            dbDisplay = `${dbUrl} (env var not set)`;
          }
        } else {
          dbDisplay = maskDbUrl(dbUrl);
        }
      } catch {
        dbDisplay = "Configured (URL parse error)";
      }
    }

    // Server config
    const serverPort = config.server?.port ?? 3001;
    const serverHost = config.server?.host ?? "0.0.0.0";

    if (outputJson) {
      const info = {
        configPath,
        capabilities: capabilities.map((c) => ({
          name: c.name,
          type: c.type,
          category: c.category,
          version: c.version,
          label: c.label,
        })),
        counts: {
          capabilities: capabilities.length,
          schemas: schemaCount,
          actions: actionCount,
          views: viewCount,
          rules: ruleCount,
          links: linkCount,
          flows: flowCount,
          states: stateCount,
          eventHandlers: eventHandlerCount,
        },
        transports: transportNames,
        database: {
          configured: hasDatabase,
          url: dbDisplay,
        },
        server: {
          port: serverPort,
          host: serverHost,
        },
      };
      console.log(JSON.stringify(info, null, 2));
      return;
    }

    // Human-readable output
    console.log("");
    console.log("  LinchKit Project Info");
    console.log("  =====================");
    console.log("");
    console.log(`  Config:       ${configPath}`);
    console.log(`  Server:       ${serverHost}:${serverPort}`);
    console.log(`  Database:     ${dbDisplay}`);
    console.log("");

    // Capabilities table
    console.log(`  Capabilities: ${capabilities.length}`);
    if (capabilities.length > 0) {
      console.log("");
      const maxNameLen = Math.max(...capabilities.map((c) => c.name.length), 4);
      const header = `    ${"Name".padEnd(maxNameLen)}  ${"Type".padEnd(10)}  ${"Category".padEnd(14)}  Version`;
      console.log(header);
      console.log(`    ${"─".repeat(maxNameLen)}  ${"─".repeat(10)}  ${"─".repeat(14)}  ${"─".repeat(8)}`);
      for (const cap of capabilities) {
        console.log(
          `    ${cap.name.padEnd(maxNameLen)}  ${cap.type.padEnd(10)}  ${cap.category.padEnd(14)}  ${cap.version}`,
        );
      }
    }

    console.log("");
    console.log("  Registered resources:");
    console.log(`    Schemas:         ${schemaCount}`);
    console.log(`    Actions:         ${actionCount}`);
    console.log(`    Views:           ${viewCount}`);
    console.log(`    Rules:           ${ruleCount}`);
    console.log(`    Links:           ${linkCount}`);
    console.log(`    States:          ${stateCount}`);
    console.log(`    Flows:           ${flowCount}`);
    console.log(`    Event Handlers:  ${eventHandlerCount}`);
    console.log(`    Transports:      ${transportNames.length > 0 ? transportNames.join(", ") : "none"}`);
    console.log("");
  },
});

/** Mask password in a PostgreSQL URL for safe display */
function maskDbUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "****";
    }
    return parsed.toString();
  } catch {
    return "Configured";
  }
}
