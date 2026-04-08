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
 *   relations           — Relation graph overview grouped by source entity
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
  initI18n,
  registerTranslations,
} from "@linchkit/core";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";
import {
  buildRelationsOverview,
  printActionDescription,
  printCapabilityDescription,
  printEntityDescription,
  printOverview,
  printRelationsOverview,
} from "./describe-formatters";

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

const relationsSubcommand = defineCommand({
  meta: {
    name: "relations",
    description: "Relation graph overview: all relations grouped by source entity",
  },
  args: {
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const { capabilities } = await loadProjectCaps();
    const defs = collectDefinitions(capabilities);
    const overview = buildRelationsOverview(defs.relations);
    if (args.json) {
      console.log(JSON.stringify(overview, null, 2));
    } else {
      printRelationsOverview(overview);
    }
  },
});

// ── Main command ──────────────────────────────────────────

export const describeCommand = defineCommand({
  meta: {
    name: "describe",
    description: "Project introspection: overview, entity, action, capability, or relations",
  },
  subCommands: {
    entity: entitySubcommand,
    action: actionSubcommand,
    capability: capabilitySubcommand,
    relations: relationsSubcommand,
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
