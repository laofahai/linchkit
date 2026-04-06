/**
 * linch describe — Project introspection for developers and AI tools
 *
 * Shows a comprehensive overview of the current project's meta-model.
 * Loads the LinchKit config, resolves all capabilities, and displays
 * entities, actions, rules, states, flows, relations.
 *
 * Subcommands:
 *   (none)          — Show project overview
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
  buildProjectOverview,
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

// ── Config loading ──────────────────────────────────────

interface LoadedProject {
  config: LinchKitConfig;
  capabilities: CapabilityDefinition[];
  entities: EntityDefinition[];
  actions: ActionDefinition[];
  rules: RuleDefinition[];
  states: StateDefinition[];
  flows: FlowDefinition[];
  relations: RelationDefinition[];
  views: ViewDefinition[];
}

async function loadProject(): Promise<LoadedProject> {
  let config: LinchKitConfig;
  try {
    const result = await loadConfig();
    config = result.config;
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

  return { config, capabilities, entities, actions, rules, states, flows, relations, views };
}

// ── Formatters ──────────────────────────────────────────

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
    const stateList = desc.states.states.join(" -> ");
    console.log(`  States: ${desc.states.name} (${stateList})`);
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
    for (const f of desc.input) {
      console.log(`  ${formatFieldDesc(f)}`);
    }
    console.log("");
  }

  if (desc.output.length > 0) {
    console.log("  Output:");
    for (const f of desc.output) {
      console.log(`  ${formatFieldDesc(f)}`);
    }
    console.log("");
  }

  if (desc.effects.length > 0) {
    console.log("  Effects:");
    for (const e of desc.effects) {
      console.log(`    - ${e}`);
    }
    console.log("");
  }

  console.log("");
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
    for (const f of desc.properties) {
      console.log(`  ${formatFieldDesc(f)}`);
    }
  }

  console.log("");
}

// ── Subcommands ─────────────────────────────────────────

const entitySubcommand = defineCommand({
  meta: {
    name: "entity",
    description: "Show detailed entity information",
  },
  args: {
    name: {
      type: "positional",
      description: "Entity name",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Output as JSON (for AI tools)",
      default: false,
    },
  },
  async run({ args }) {
    const outputJson = args.json as boolean;
    const name = args.name as string;
    const project = await loadProject();

    const entity = project.entities.find((e) => e.name === name);
    if (!entity) {
      console.error(`[linch] Entity "${name}" not found.`);
      console.error(
        `[linch] Available entities: ${project.entities.map((e) => e.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }

    const desc = describeEntity(entity, {
      actions: project.actions,
      states: project.states,
      relations: project.relations,
      views: project.views,
    });

    if (outputJson) {
      console.log(JSON.stringify(desc, null, 2));
    } else {
      printEntityDescription(desc);
    }
  },
});

const actionSubcommand = defineCommand({
  meta: {
    name: "action",
    description: "Show detailed action information",
  },
  args: {
    name: {
      type: "positional",
      description: "Action name",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Output as JSON (for AI tools)",
      default: false,
    },
  },
  async run({ args }) {
    const outputJson = args.json as boolean;
    const name = args.name as string;
    const project = await loadProject();

    const action = project.actions.find((a) => a.name === name);
    if (!action) {
      console.error(`[linch] Action "${name}" not found.`);
      console.error(
        `[linch] Available actions: ${project.actions.map((a) => a.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }

    const desc = describeAction(action);

    if (outputJson) {
      console.log(JSON.stringify(desc, null, 2));
    } else {
      printActionDescription(desc);
    }
  },
});

const relationSubcommand = defineCommand({
  meta: {
    name: "relation",
    description: "Show detailed relation information",
  },
  args: {
    name: {
      type: "positional",
      description: "Relation name",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Output as JSON (for AI tools)",
      default: false,
    },
  },
  async run({ args }) {
    const outputJson = args.json as boolean;
    const name = args.name as string;
    const project = await loadProject();

    const relation = project.relations.find((l) => l.name === name);
    if (!relation) {
      console.error(`[linch] Relation "${name}" not found.`);
      console.error(
        `[linch] Available relations: ${project.relations.map((l) => l.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }

    const desc = describeRelation(relation);

    if (outputJson) {
      console.log(JSON.stringify(desc, null, 2));
    } else {
      printRelationDescription(desc);
    }
  },
});

// ── Main command ────────────────────────────────────────

export const describeCommand = defineCommand({
  meta: {
    name: "describe",
    description: "Show project meta-model overview (entities, actions, rules, states, flows, relations)",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON (for AI tools)",
      default: false,
    },
  },
  subCommands: {
    entity: entitySubcommand,
    action: actionSubcommand,
    relation: relationSubcommand,
  },
  async run({ args }) {
    const outputJson = args.json as boolean;
    const project = await loadProject();

    const overview = buildProjectOverview({
      capabilities: project.capabilities,
    });

    if (outputJson) {
      console.log(JSON.stringify(overview, null, 2));
      return;
    }

    // Human-readable output
    console.log("");
    console.log("  LinchKit Project Overview");
    console.log("  =========================");
    console.log("");
    console.log(`  Capabilities: ${overview.capabilities.length} loaded`);
    console.log(`  Entities:     ${overview.entities.length} defined`);
    console.log(`  Actions:      ${overview.actions.length} defined`);
    console.log(`  Rules:        ${overview.rules.length} defined`);
    console.log(`  States:       ${overview.states.length} defined`);
    console.log(`  Flows:        ${overview.flows.length} defined`);
    console.log(`  Relations:    ${overview.relations.length} defined`);
    console.log("");

    // List capabilities
    if (overview.capabilities.length > 0) {
      console.log("  Capabilities:");
      for (const cap of overview.capabilities) {
        console.log(`    - ${cap.name} (${cap.type}, v${cap.version})`);
      }
      console.log("");
    }

    // List entities
    if (overview.entities.length > 0) {
      console.log("  Entities:");
      for (const e of overview.entities) {
        const label = e.label ? ` — ${e.label}` : "";
        console.log(`    - ${e.name} (${e.fieldCount} fields)${label}`);
      }
      console.log("");
    }

    // List actions
    if (overview.actions.length > 0) {
      console.log("  Actions:");
      for (const a of overview.actions) {
        console.log(`    - ${a.name} [${a.entity}] — ${a.label}`);
      }
      console.log("");
    }

    // List relations
    if (overview.relations.length > 0) {
      console.log("  Relations:");
      for (const r of overview.relations) {
        console.log(`    - ${r.name}: ${r.from} -> ${r.to} (${r.type})`);
      }
      console.log("");
    }

    // List states
    if (overview.states.length > 0) {
      console.log("  States:");
      for (const s of overview.states) {
        console.log(`    - ${s.name} [${s.entity}] (${s.stateCount} states)`);
      }
      console.log("");
    }

    // List flows
    if (overview.flows.length > 0) {
      console.log("  Flows:");
      for (const f of overview.flows) {
        const label = f.label ? ` — ${f.label}` : "";
        console.log(`    - ${f.name}${label}`);
      }
      console.log("");
    }

    // List rules
    if (overview.rules.length > 0) {
      console.log("  Rules:");
      for (const r of overview.rules) {
        console.log(`    - ${r.name} — ${r.label}`);
      }
      console.log("");
    }
  },
});
