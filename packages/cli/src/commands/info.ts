/**
 * linch info — Display current project information
 *
 * Shows registered capabilities, schema/action counts, database status,
 * and other project metadata by loading linchkit.config.ts.
 *
 * Subcommands:
 *   entity <name>   — Show detailed entity info
 *   action <name>   — Show detailed action info
 *   relation <name> — Show detailed relation info
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  EntityDefinition,
  FlowDefinition,
  LinchKitConfig,
  RelationDefinition,
  RuleDefinition,
  StateDefinition,
  ViewDefinition,
} from "@linchkit/core";
import {
  describeAction,
  describeEntity,
  describeRelation,
  type ActionDescription,
  type EntityDescription,
  type FieldDescription,
  type RelationDescription,
} from "@linchkit/core";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";

// ── Detail helpers ─────────────────────────────────────

function collectDefinitions(capabilities: CapabilityDefinition[]) {
  const entities: EntityDefinition[] = [];
  const actions: ActionDefinition[] = [];
  const rules: RuleDefinition[] = [];
  const states: StateDefinition[] = [];
  const flows: FlowDefinition[] = [];
  const relations: RelationDefinition[] = [];
  const views: ViewDefinition[] = [];

  for (const cap of capabilities) {
    if (cap.entities) entities.push(...cap.entities);
    if (cap.actions) actions.push(...cap.actions);
    if (cap.rules) rules.push(...cap.rules);
    if (cap.states) states.push(...cap.states);
    if (cap.flows) flows.push(...cap.flows);
    if (cap.relations) relations.push(...cap.relations);
    if (cap.views) views.push(...cap.views);
  }

  return { entities, actions, rules, states, flows, relations, views };
}

function formatFieldDesc(f: FieldDescription): string {
  const parts: string[] = [];
  if (f.system) parts.push("system");
  if (f.required) parts.push("required");
  if (f.constraints) {
    for (const [k, v] of Object.entries(f.constraints)) {
      if (k === "enum") {
        parts.push(`enum: [${(v as string[]).join(", ")}]`);
      } else {
        parts.push(`${k}: ${v}`);
      }
    }
  }
  const suffix = parts.length > 0 ? `, ${parts.join(", ")}` : "";
  const label = f.label ? ` "${f.label}"` : "";
  return `  - ${f.name} (${f.type}${suffix})${label}`;
}

function printEntityDescription(desc: EntityDescription): void {
  console.log("");
  console.log(`  Entity: ${desc.name}`);
  if (desc.label) console.log(`  Label:  ${desc.label}`);
  if (desc.description) console.log(`  Desc:   ${desc.description}`);
  console.log("");
  console.log("  Fields:");
  for (const f of desc.fields) {
    console.log(`  ${formatFieldDesc(f)}`);
  }
  console.log("");
  if (desc.actions.length > 0) {
    console.log(`  Actions: ${desc.actions.map((a) => a.name).join(", ")}`);
  }
  if (desc.states) {
    console.log(`  States: ${desc.states.name} (${desc.states.states.join(" -> ")})`);
    console.log(`  Initial: ${desc.states.initial}`);
  }
  if (desc.relations.length > 0) {
    console.log("  Relations:");
    for (const r of desc.relations) {
      const arrow = r.direction === "outgoing" ? "->" : "<-";
      console.log(`    ${arrow} ${r.target} (${r.cardinality}) via ${r.name}`);
    }
  }
  if (desc.views.length > 0) {
    console.log(`  Views: ${desc.views.map((v) => `${v.name} (${v.type})`).join(", ")}`);
  }
  console.log("");
}

function printActionDescription(desc: ActionDescription): void {
  console.log("");
  console.log(`  Action: ${desc.name}`);
  console.log(`  Entity: ${desc.entity}`);
  console.log(`  Label:  ${desc.label}`);
  if (desc.description) console.log(`  Desc:   ${desc.description}`);
  console.log("");
  if (desc.input.length > 0) {
    console.log("  Input:");
    for (const f of desc.input) console.log(`  ${formatFieldDesc(f)}`);
    console.log("");
  }
  if (desc.output.length > 0) {
    console.log("  Output:");
    for (const f of desc.output) console.log(`  ${formatFieldDesc(f)}`);
    console.log("");
  }
  if (desc.effects.length > 0) {
    console.log("  Effects:");
    for (const e of desc.effects) console.log(`    - ${e}`);
    console.log("");
  }
}

function printRelationDescription(desc: RelationDescription): void {
  console.log("");
  console.log(`  Relation: ${desc.name}`);
  console.log(`  From:     ${desc.from}`);
  console.log(`  To:       ${desc.to}`);
  console.log(`  Type:     ${desc.cardinality}`);
  if (desc.description) console.log(`  Desc:     ${desc.description}`);
  if (desc.label?.from) console.log(`  Label (from): ${desc.label.from}`);
  if (desc.label?.to) console.log(`  Label (to):   ${desc.label.to}`);
  console.log(`  Required: ${desc.required ? "yes" : "no"}`);
  console.log(`  Cascade:  ${desc.cascade}`);
  if (desc.properties.length > 0) {
    console.log("  Properties:");
    for (const f of desc.properties) console.log(`  ${formatFieldDesc(f)}`);
  }
  console.log("");
}

// ── Subcommands ─────────────────────────────────────────

async function loadProjectCaps(): Promise<{ config: LinchKitConfig; capabilities: CapabilityDefinition[] }> {
  let config: LinchKitConfig;
  try {
    const result = await loadConfig();
    config = result.config;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[linch] Failed to load config: ${msg}`);
    process.exit(1);
  }
  return { config, capabilities: (config.capabilities ?? []) as CapabilityDefinition[] };
}

const entitySubcommand = defineCommand({
  meta: { name: "entity", description: "Show detailed entity information" },
  args: {
    name: { type: "positional", description: "Entity name", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const { capabilities } = await loadProjectCaps();
    const defs = collectDefinitions(capabilities);
    const entity = defs.entities.find((e) => e.name === (args.name as string));
    if (!entity) {
      console.error(`[linch] Entity "${args.name}" not found. Available: ${defs.entities.map((e) => e.name).join(", ") || "(none)"}`);
      process.exit(1);
    }
    const desc = describeEntity(entity, { actions: defs.actions, states: defs.states, relations: defs.relations, views: defs.views });
    if (args.json) { console.log(JSON.stringify(desc, null, 2)); } else { printEntityDescription(desc); }
  },
});

const actionSubcommand = defineCommand({
  meta: { name: "action", description: "Show detailed action information" },
  args: {
    name: { type: "positional", description: "Action name", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const { capabilities } = await loadProjectCaps();
    const defs = collectDefinitions(capabilities);
    const action = defs.actions.find((a) => a.name === (args.name as string));
    if (!action) {
      console.error(`[linch] Action "${args.name}" not found. Available: ${defs.actions.map((a) => a.name).join(", ") || "(none)"}`);
      process.exit(1);
    }
    const desc = describeAction(action);
    if (args.json) { console.log(JSON.stringify(desc, null, 2)); } else { printActionDescription(desc); }
  },
});

const relationSubcommand = defineCommand({
  meta: { name: "relation", description: "Show detailed relation information" },
  args: {
    name: { type: "positional", description: "Relation name", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const { capabilities } = await loadProjectCaps();
    const defs = collectDefinitions(capabilities);
    const relation = defs.relations.find((r) => r.name === (args.name as string));
    if (!relation) {
      console.error(`[linch] Relation "${args.name}" not found. Available: ${defs.relations.map((r) => r.name).join(", ") || "(none)"}`);
      process.exit(1);
    }
    const desc = describeRelation(relation);
    if (args.json) { console.log(JSON.stringify(desc, null, 2)); } else { printRelationDescription(desc); }
  },
});

// ── Main command ────────────────────────────────────────

export const infoCommand = defineCommand({
  meta: {
    name: "info",
    description: "Show project info, or drill into entity/action/relation details",
  },
  subCommands: {
    entity: entitySubcommand,
    action: actionSubcommand,
    relation: relationSubcommand,
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
        console.error(
          "[linch] No linchkit.config.ts found. Are you in a LinchKit project directory?",
        );
        console.error("[linch] Run 'linch init' to create a new project.");
      } else {
        console.error(`[linch] Failed to load config: ${msg}`);
      }
      process.exit(1);
    }

    const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];

    // Collect statistics
    let entityCount = 0;
    let actionCount = 0;
    let viewCount = 0;
    let ruleCount = 0;
    let relationCount = 0;
    let flowCount = 0;
    let stateCount = 0;
    let eventHandlerCount = 0;
    const transportNames: string[] = [];

    for (const cap of capabilities) {
      if (cap.entities) entityCount += cap.entities.length;
      if (cap.actions) actionCount += cap.actions.length;
      if (cap.views) viewCount += cap.views.length;
      if (cap.rules) ruleCount += cap.rules.length;
      if (cap.relations) relationCount += cap.relations.length;
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
        // URL parsing or env var resolution failed — show safe fallback
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
          entities: entityCount,
          actions: actionCount,
          views: viewCount,
          rules: ruleCount,
          links: relationCount,
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
      console.log(
        `    ${"─".repeat(maxNameLen)}  ${"─".repeat(10)}  ${"─".repeat(14)}  ${"─".repeat(8)}`,
      );
      for (const cap of capabilities) {
        console.log(
          `    ${cap.name.padEnd(maxNameLen)}  ${cap.type.padEnd(10)}  ${cap.category.padEnd(14)}  ${cap.version}`,
        );
      }
    }

    console.log("");
    console.log("  Registered resources:");
    console.log(`    Schemas:         ${entityCount}`);
    console.log(`    Actions:         ${actionCount}`);
    console.log(`    Views:           ${viewCount}`);
    console.log(`    Rules:           ${ruleCount}`);
    console.log(`    Links:           ${relationCount}`);
    console.log(`    States:          ${stateCount}`);
    console.log(`    Flows:           ${flowCount}`);
    console.log(`    Event Handlers:  ${eventHandlerCount}`);
    console.log(
      `    Transports:      ${transportNames.length > 0 ? transportNames.join(", ") : "none"}`,
    );
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
    // URL constructor threw — return generic label to avoid leaking credentials
    return "Configured";
  }
}
