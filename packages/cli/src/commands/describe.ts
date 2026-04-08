/**
 * linch describe — Project introspection for humans and AI tools
 *
 * Wraps OntologyRegistry and describe helpers to provide readable
 * project overviews from the command line.
 *
 * Subcommands:
 *   (none)              — Project overview: capabilities, entity/action/rule counts
 *   entity <name>       — Entity details: fields, actions, rules, states, relations
 *   action <name>       — Action details: input/output, state transitions, effects
 *   capability <name>   — Capability structure: what it provides
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
  type ActionDescription,
  buildProjectOverview,
  describeAction,
  describeEntity,
  type EntityDescription,
  type FieldDescription,
  initI18n,
  type ProjectOverview,
  registerTranslations,
} from "@linchkit/core";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";

// ── Shared helpers ────────────────────────────────────────

interface ProjectDefinitions {
  entities: EntityDefinition[];
  actions: ActionDefinition[];
  rules: RuleDefinition[];
  states: StateDefinition[];
  flows: FlowDefinition[];
  relations: RelationDefinition[];
  views: ViewDefinition[];
}

function collectDefinitions(capabilities: CapabilityDefinition[]): ProjectDefinitions {
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

async function loadProjectCaps(): Promise<{
  config: LinchKitConfig;
  capabilities: CapabilityDefinition[];
}> {
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
    } else {
      console.error(`[linch] Failed to load config: ${msg}`);
    }
    process.exit(1);
  }

  await initI18n();
  const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];
  for (const cap of capabilities) {
    if (cap.extensions?.i18n) {
      for (const [locale, resources] of Object.entries(cap.extensions.i18n)) {
        registerTranslations(cap.name, locale, resources as Record<string, unknown>);
      }
    }
  }

  return { config, capabilities };
}

// ── Formatting helpers ────────────────────────────────────

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
  return `    ${f.name} (${f.type}${suffix})${label}`;
}

function printOverview(overview: ProjectOverview): void {
  console.log("");
  console.log("  LinchKit Project Overview");
  console.log("  =========================");
  console.log("");

  // Capabilities
  console.log(`  Capabilities (${overview.capabilities.length}):`);
  if (overview.capabilities.length > 0) {
    for (const cap of overview.capabilities) {
      console.log(`    - ${cap.name} (${cap.type}) v${cap.version}`);
    }
  } else {
    console.log("    (none)");
  }
  console.log("");

  // Entities
  console.log(`  Entities (${overview.entities.length}):`);
  if (overview.entities.length > 0) {
    for (const e of overview.entities) {
      const label = e.label ? ` "${e.label}"` : "";
      console.log(`    - ${e.name}${label} (${e.fieldCount} fields)`);
    }
  } else {
    console.log("    (none)");
  }
  console.log("");

  // Actions
  console.log(`  Actions (${overview.actions.length}):`);
  if (overview.actions.length > 0) {
    for (const a of overview.actions) {
      console.log(`    - ${a.name} -> ${a.entity} (${a.label})`);
    }
  } else {
    console.log("    (none)");
  }
  console.log("");

  // Rules
  if (overview.rules.length > 0) {
    console.log(`  Rules (${overview.rules.length}):`);
    for (const r of overview.rules) {
      console.log(`    - ${r.name} (${r.label})`);
    }
    console.log("");
  }

  // State machines
  if (overview.states.length > 0) {
    console.log(`  State Machines (${overview.states.length}):`);
    for (const s of overview.states) {
      console.log(`    - ${s.name} on ${s.entity} (${s.stateCount} states)`);
    }
    console.log("");
  }

  // Flows
  if (overview.flows.length > 0) {
    console.log(`  Flows (${overview.flows.length}):`);
    for (const f of overview.flows) {
      const label = f.label ? ` (${f.label})` : "";
      console.log(`    - ${f.name}${label}`);
    }
    console.log("");
  }

  // Relations
  if (overview.relations.length > 0) {
    console.log(`  Relations (${overview.relations.length}):`);
    for (const r of overview.relations) {
      console.log(`    - ${r.name}: ${r.from} -> ${r.to} (${r.type})`);
    }
    console.log("");
  }
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
    console.log("  Actions:");
    for (const a of desc.actions) {
      console.log(`    - ${a.name} (${a.label})`);
    }
    console.log("");
  }

  if (desc.states) {
    console.log("  State Machine:");
    console.log(`    Name:    ${desc.states.name}`);
    console.log(`    States:  ${desc.states.states.join(", ")}`);
    console.log(`    Initial: ${desc.states.initial}`);
    if (desc.states.transitions.length > 0) {
      console.log("    Transitions:");
      for (const t of desc.states.transitions) {
        const from = Array.isArray(t.from) ? t.from.join("|") : t.from;
        console.log(`      ${from} -> ${t.to} (via ${t.action})`);
      }
    }
    console.log("");
  }

  if (desc.relations.length > 0) {
    console.log("  Relations:");
    for (const r of desc.relations) {
      const arrow = r.direction === "outgoing" ? "->" : "<-";
      console.log(`    ${arrow} ${r.target} (${r.cardinality}) via ${r.name}`);
    }
    console.log("");
  }

  if (desc.views.length > 0) {
    console.log("  Views:");
    for (const v of desc.views) {
      console.log(`    - ${v.name} (${v.type})`);
    }
    console.log("");
  }
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
}

function printCapabilityDescription(cap: CapabilityDefinition): void {
  console.log("");
  console.log(`  Capability: ${cap.name}`);
  console.log(`  Label:      ${cap.label}`);
  if (cap.description) console.log(`  Desc:       ${cap.description}`);
  console.log(`  Type:       ${cap.type}`);
  console.log(`  Category:   ${cap.category}`);
  console.log(`  Version:    ${cap.version}`);
  if (cap.dependencies?.length) {
    console.log(`  Depends on: ${cap.dependencies.join(", ")}`);
  }
  console.log("");

  // Filter definitions belonging to this capability
  const capEntities = cap.entities ?? [];
  const capActions = (cap.actions ?? []) as ActionDefinition[];
  const capRules = (cap.rules ?? []) as RuleDefinition[];
  const capStates = (cap.states ?? []) as StateDefinition[];
  const capFlows = (cap.flows ?? []) as FlowDefinition[];
  const capRelations = (cap.relations ?? []) as RelationDefinition[];
  const capViews = (cap.views ?? []) as ViewDefinition[];

  if (capEntities.length > 0) {
    console.log(`  Entities (${capEntities.length}):`);
    for (const e of capEntities) {
      const fieldCount = Object.keys(e.fields).length;
      const label = e.label ? ` "${e.label}"` : "";
      console.log(`    - ${e.name}${label} (${fieldCount} fields)`);
    }
    console.log("");
  }

  if (capActions.length > 0) {
    console.log(`  Actions (${capActions.length}):`);
    for (const a of capActions) {
      console.log(`    - ${a.name} -> ${a.entity}`);
    }
    console.log("");
  }

  if (capRules.length > 0) {
    console.log(`  Rules (${capRules.length}):`);
    for (const r of capRules) {
      console.log(`    - ${r.name}`);
    }
    console.log("");
  }

  if (capStates.length > 0) {
    console.log(`  State Machines (${capStates.length}):`);
    for (const s of capStates) {
      console.log(`    - ${s.name} on ${s.entity} (${s.states.length} states)`);
    }
    console.log("");
  }

  if (capFlows.length > 0) {
    console.log(`  Flows (${capFlows.length}):`);
    for (const f of capFlows) {
      console.log(`    - ${f.name}`);
    }
    console.log("");
  }

  if (capRelations.length > 0) {
    console.log(`  Relations (${capRelations.length}):`);
    for (const r of capRelations) {
      console.log(`    - ${r.name}: ${r.from} -> ${r.to} (${r.cardinality})`);
    }
    console.log("");
  }

  if (capViews.length > 0) {
    console.log(`  Views (${capViews.length}):`);
    for (const v of capViews) {
      console.log(`    - ${v.name} (${v.type}) for ${v.entity}`);
    }
    console.log("");
  }
}

// ── Subcommands ───────────────────────────────────────────

const entitySubcommand = defineCommand({
  meta: {
    name: "entity",
    description: "Describe an entity: fields, actions, rules, states, relations",
  },
  args: {
    name: { type: "positional", description: "Entity name", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const { capabilities } = await loadProjectCaps();
    const defs = collectDefinitions(capabilities);
    const entity = defs.entities.find((e) => e.name === (args.name as string));
    if (!entity) {
      console.error(
        `[linch] Entity "${args.name}" not found. Available: ${defs.entities.map((e) => e.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }
    const desc = describeEntity(entity, {
      actions: defs.actions,
      states: defs.states,
      relations: defs.relations,
      views: defs.views,
    });
    if (args.json) {
      console.log(JSON.stringify(desc, null, 2));
    } else {
      printEntityDescription(desc);
    }
  },
});

const actionSubcommand = defineCommand({
  meta: { name: "action", description: "Describe an action: input/output, rules, effects" },
  args: {
    name: { type: "positional", description: "Action name", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const { capabilities } = await loadProjectCaps();
    const defs = collectDefinitions(capabilities);
    const action = defs.actions.find((a) => a.name === (args.name as string));
    if (!action) {
      console.error(
        `[linch] Action "${args.name}" not found. Available: ${defs.actions.map((a) => a.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }
    const desc = describeAction(action);
    if (args.json) {
      console.log(JSON.stringify(desc, null, 2));
    } else {
      printActionDescription(desc);
    }
  },
});

const capabilitySubcommand = defineCommand({
  meta: {
    name: "capability",
    description: "Describe a capability: entities, actions, rules, views",
  },
  args: {
    name: { type: "positional", description: "Capability name", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const { capabilities } = await loadProjectCaps();
    const defs = collectDefinitions(capabilities);
    const cap = capabilities.find((c) => c.name === (args.name as string));
    if (!cap) {
      console.error(
        `[linch] Capability "${args.name}" not found. Available: ${capabilities.map((c) => c.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }
    if (args.json) {
      const summary = {
        name: cap.name,
        label: cap.label,
        description: cap.description,
        type: cap.type,
        category: cap.category,
        version: cap.version,
        dependencies: cap.dependencies ?? [],
        entities: (cap.entities ?? []).map((e) => e.name),
        actions: ((cap.actions ?? []) as ActionDefinition[]).map((a) => a.name),
        rules: ((cap.rules ?? []) as RuleDefinition[]).map((r) => r.name),
        states: ((cap.states ?? []) as StateDefinition[]).map((s) => s.name),
        flows: ((cap.flows ?? []) as FlowDefinition[]).map((f) => f.name),
        relations: ((cap.relations ?? []) as RelationDefinition[]).map((r) => r.name),
        views: ((cap.views ?? []) as ViewDefinition[]).map((v) => v.name),
      };
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printCapabilityDescription(cap);
    }
  },
});

// ── Main command ──────────────────────────────────────────

export const describeCommand = defineCommand({
  meta: {
    name: "describe",
    description: "Project introspection: overview, entity, action, or capability details",
  },
  subCommands: {
    entity: entitySubcommand,
    action: actionSubcommand,
    capability: capabilitySubcommand,
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const { capabilities } = await loadProjectCaps();
    const overview = buildProjectOverview({ capabilities });

    if (args.json) {
      console.log(JSON.stringify(overview, null, 2));
    } else {
      printOverview(overview);
    }
  },
});
