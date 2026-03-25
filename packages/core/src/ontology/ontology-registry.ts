/**
 * Ontology Registry — Unified semantic facade over all registries
 *
 * Read-only aggregator that combines SchemaRegistry, ActionRegistry,
 * LinkRegistry, and raw definition arrays to provide unified introspection
 * for AI agents, MCP tools, and documentation generation.
 *
 * See spec: docs/specs/43_ontology_layer.md
 */

import type { ActionDefinition } from "../types/action";
import type { EventDefinition, EventHandlerDefinition } from "../types/event";
import type { FlowDefinition } from "../types/flow";
import type { LinkCardinality } from "../types/link";
import type { RuleDefinition } from "../types/rule";
import type { FieldDefinition, SchemaDefinition, SchemaPresentation } from "../types/schema";
import type { StateDefinition } from "../types/state";
import type { ViewDefinition } from "../types/view";

// ── Relation descriptor ──────────────────────────────────

/** Directional relationship between two schemas */
export interface RelationDescriptor {
  /** Name of the link definition */
  linkName: string;
  /** Direction relative to the querying schema */
  direction: "outgoing" | "incoming";
  /** Schema on the other end of the relation */
  targetSchema: string;
  /** Cardinality of the link */
  cardinality: LinkCardinality;
  /** Human-readable label for this direction */
  label?: string;
}

// ── Schema descriptor ──────────────────────────────────

/** Complete picture of a schema — all metadata in one place */
export interface SchemaDescriptor {
  /** Schema name */
  name: string;
  /** Human-readable label */
  label?: string;
  /** Schema description */
  description?: string;
  /** Field definitions */
  fields: Record<string, FieldDefinition>;
  /** Presentation metadata */
  presentation?: SchemaPresentation;
  /** Relations from LinkRegistry */
  relations: RelationDescriptor[];
  /** Actions operating on this schema */
  actions: ActionDefinition[];
  /** Rules affecting this schema */
  rules: RuleDefinition[];
  /** State machine (if defined) */
  states?: StateDefinition;
  /** Views for this schema */
  views: ViewDefinition[];
  /** Flows triggered by this schema's actions/events */
  flows: FlowDefinition[];
  /** Event handlers listening to this schema's events */
  handlers: EventHandlerDefinition[];
}

// ── Registry dependencies ──────────────────────────────────

/** Minimal interface for SchemaRegistry (avoids importing the class) */
interface SchemaRegistryLike {
  getAll(): SchemaDefinition[];
  get(name: string): SchemaDefinition | undefined;
  has(name: string): boolean;
}

/** Minimal interface for ActionRegistry */
interface ActionRegistryLike {
  getAll(): ActionDefinition[];
}

/** Minimal interface for LinkRegistry */
interface LinkRegistryLike {
  linksFor(schemaName: string): Array<{
    link: { name: string; from: string; to: string; cardinality: LinkCardinality; label?: { from?: string; to?: string } };
    direction: "outgoing" | "incoming";
    relatedSchema: string;
    label: string;
  }>;
}

/** Minimal interface for FlowRegistry */
interface FlowRegistryLike {
  getAll(): FlowDefinition[];
}

/** Minimal interface for EventHandlerRegistry */
interface EventHandlerRegistryLike {
  getAll(): EventHandlerDefinition[];
}

// ── Dependencies for createOntologyRegistry ──────────────────

export interface OntologyRegistryDeps {
  schemas: SchemaRegistryLike;
  actions: ActionRegistryLike;
  rules: RuleDefinition[];
  states: StateDefinition[];
  events?: EventDefinition[];
  handlers?: EventHandlerRegistryLike;
  views: ViewDefinition[];
  flows?: FlowRegistryLike;
  links?: LinkRegistryLike;
}

// ── OntologyRegistry interface ──────────────────────────────

export interface OntologyRegistry {
  /** Get complete descriptor for a schema */
  describe(schemaName: string): SchemaDescriptor | undefined;

  /** List all schema names in the ontology */
  listSchemas(): string[];

  /** Search schemas by keyword (matches name, label, description, field names) */
  searchSchemas(query: string): SchemaDescriptor[];

  /** Get all actions operating on a schema */
  actionsFor(schemaName: string): ActionDefinition[];

  /** Get all rules affecting a schema */
  rulesFor(schemaName: string): RuleDefinition[];

  /** Get the state machine for a schema (if any) */
  stateFor(schemaName: string): StateDefinition | undefined;

  /** Get all views for a schema */
  viewsFor(schemaName: string): ViewDefinition[];

  /** Get all flows related to a schema */
  flowsFor(schemaName: string): FlowDefinition[];

  /** Get all event handlers related to a schema */
  handlersFor(schemaName: string): EventHandlerDefinition[];

  /** Get all relations for a schema */
  relatedSchemas(schemaName: string): RelationDescriptor[];

  /** Export full ontology as JSON */
  toJSON(): Record<string, SchemaDescriptor>;

  /** Export ontology as Markdown summary */
  toMarkdown(): string;
}

// ── Factory ──────────────────────────────────────────────

/**
 * Create an OntologyRegistry that aggregates existing registries.
 *
 * Build once after all capabilities have registered their definitions.
 * Results are cached per schema name (immutable after construction).
 */
export function createOntologyRegistry(deps: OntologyRegistryDeps): OntologyRegistry {
  const cache = new Map<string, SchemaDescriptor>();

  // Pre-index actions by schema
  const actionsBySchema = new Map<string, ActionDefinition[]>();
  for (const action of deps.actions.getAll()) {
    const list = actionsBySchema.get(action.schema) ?? [];
    list.push(action);
    actionsBySchema.set(action.schema, list);
  }

  // Pre-index rules by schema (via trigger)
  const rulesBySchema = new Map<string, RuleDefinition[]>();
  for (const rule of deps.rules) {
    const schemaNames = extractSchemaFromTrigger(rule);
    for (const sn of schemaNames) {
      const list = rulesBySchema.get(sn) ?? [];
      list.push(rule);
      rulesBySchema.set(sn, list);
    }
  }

  // Pre-index states by schema
  const statesBySchema = new Map<string, StateDefinition>();
  for (const state of deps.states) {
    statesBySchema.set(state.schema, state);
  }

  // Pre-index views by schema
  const viewsBySchema = new Map<string, ViewDefinition[]>();
  for (const view of deps.views) {
    const list = viewsBySchema.get(view.schema) ?? [];
    list.push(view);
    viewsBySchema.set(view.schema, list);
  }

  // Pre-index flows by related schema (inferred from action steps)
  const flowsBySchema = new Map<string, FlowDefinition[]>();
  if (deps.flows) {
    for (const flow of deps.flows.getAll()) {
      const relatedSchemas = extractSchemasFromFlow(flow, actionsBySchema);
      for (const sn of relatedSchemas) {
        const list = flowsBySchema.get(sn) ?? [];
        list.push(flow);
        flowsBySchema.set(sn, list);
      }
    }
  }

  // Pre-index handlers by schema (inferred from event names like "schema.action.succeeded")
  const handlersBySchema = new Map<string, EventHandlerDefinition[]>();
  if (deps.handlers) {
    for (const handler of deps.handlers.getAll()) {
      const schemaNames = extractSchemasFromHandler(handler, deps.schemas);
      for (const sn of schemaNames) {
        const list = handlersBySchema.get(sn) ?? [];
        list.push(handler);
        handlersBySchema.set(sn, list);
      }
    }
  }

  function buildDescriptor(schemaName: string): SchemaDescriptor | undefined {
    const schema = deps.schemas.get(schemaName);
    if (!schema) return undefined;

    const relations: RelationDescriptor[] = [];
    if (deps.links) {
      for (const info of deps.links.linksFor(schemaName)) {
        relations.push({
          linkName: info.link.name,
          direction: info.direction,
          targetSchema: info.relatedSchema,
          cardinality: info.link.cardinality,
          label: info.label,
        });
      }
    }

    return {
      name: schema.name,
      label: schema.label,
      description: schema.description,
      fields: schema.fields,
      presentation: schema.presentation,
      relations,
      actions: actionsBySchema.get(schemaName) ?? [],
      rules: rulesBySchema.get(schemaName) ?? [],
      states: statesBySchema.get(schemaName),
      views: viewsBySchema.get(schemaName) ?? [],
      flows: flowsBySchema.get(schemaName) ?? [],
      handlers: handlersBySchema.get(schemaName) ?? [],
    };
  }

  function getOrBuild(schemaName: string): SchemaDescriptor | undefined {
    if (cache.has(schemaName)) return cache.get(schemaName);
    const desc = buildDescriptor(schemaName);
    if (desc) cache.set(schemaName, desc);
    return desc;
  }

  return {
    describe(schemaName: string): SchemaDescriptor | undefined {
      return getOrBuild(schemaName);
    },

    listSchemas(): string[] {
      return deps.schemas.getAll().map((s) => s.name);
    },

    searchSchemas(query: string): SchemaDescriptor[] {
      const q = query.toLowerCase();
      const results: SchemaDescriptor[] = [];

      for (const schema of deps.schemas.getAll()) {
        const desc = getOrBuild(schema.name);
        if (!desc) continue;

        // Match against name, label, description, and field names
        const haystack = [
          desc.name,
          desc.label ?? "",
          desc.description ?? "",
          ...Object.keys(desc.fields),
        ]
          .join(" ")
          .toLowerCase();

        if (haystack.includes(q)) {
          results.push(desc);
        }
      }

      return results;
    },

    actionsFor(schemaName: string): ActionDefinition[] {
      return actionsBySchema.get(schemaName) ?? [];
    },

    rulesFor(schemaName: string): RuleDefinition[] {
      return rulesBySchema.get(schemaName) ?? [];
    },

    stateFor(schemaName: string): StateDefinition | undefined {
      return statesBySchema.get(schemaName);
    },

    viewsFor(schemaName: string): ViewDefinition[] {
      return viewsBySchema.get(schemaName) ?? [];
    },

    flowsFor(schemaName: string): FlowDefinition[] {
      return flowsBySchema.get(schemaName) ?? [];
    },

    handlersFor(schemaName: string): EventHandlerDefinition[] {
      return handlersBySchema.get(schemaName) ?? [];
    },

    relatedSchemas(schemaName: string): RelationDescriptor[] {
      const desc = getOrBuild(schemaName);
      return desc?.relations ?? [];
    },

    toJSON(): Record<string, SchemaDescriptor> {
      const result: Record<string, SchemaDescriptor> = {};
      for (const schema of deps.schemas.getAll()) {
        const desc = getOrBuild(schema.name);
        if (desc) result[schema.name] = desc;
      }
      return result;
    },

    toMarkdown(): string {
      const lines: string[] = ["# Ontology", ""];
      for (const schema of deps.schemas.getAll()) {
        const desc = getOrBuild(schema.name);
        if (!desc) continue;

        lines.push(`## ${desc.label ?? desc.name}`);
        if (desc.description) lines.push(`> ${desc.description}`);
        lines.push("");

        // Fields
        lines.push("### Fields");
        for (const [name, field] of Object.entries(desc.fields)) {
          const label = field.label ? ` (${field.label})` : "";
          const req = field.required ? " *required*" : "";
          lines.push(`- **${name}**${label}: \`${field.type}\`${req}`);
        }
        lines.push("");

        // Relations
        if (desc.relations.length > 0) {
          lines.push("### Relations");
          for (const rel of desc.relations) {
            lines.push(
              `- ${rel.direction === "outgoing" ? "→" : "←"} **${rel.targetSchema}** (${rel.cardinality}) via \`${rel.linkName}\``,
            );
          }
          lines.push("");
        }

        // Actions
        if (desc.actions.length > 0) {
          lines.push("### Actions");
          for (const action of desc.actions) {
            lines.push(`- **${action.name}**: ${action.label}`);
          }
          lines.push("");
        }

        // Rules
        if (desc.rules.length > 0) {
          lines.push("### Rules");
          for (const rule of desc.rules) {
            lines.push(`- **${rule.name}**: ${rule.label}`);
          }
          lines.push("");
        }

        // State machine
        if (desc.states) {
          lines.push("### State Machine");
          lines.push(`- States: ${desc.states.states.join(", ")}`);
          lines.push(`- Initial: ${desc.states.initial}`);
          lines.push("");
        }

        // Views
        if (desc.views.length > 0) {
          lines.push("### Views");
          for (const view of desc.views) {
            lines.push(`- **${view.name}** (${view.type})`);
          }
          lines.push("");
        }
      }

      return lines.join("\n");
    },
  };
}

// ── Helpers ──────────────────────────────────────────────

/** Extract schema names from a rule trigger */
function extractSchemaFromTrigger(rule: RuleDefinition): string[] {
  const trigger = rule.trigger;

  // ActionTrigger: look up action names to find their schema
  if ("action" in trigger) {
    // We can't resolve action→schema at this level without access to the action registry,
    // so we return empty. Rules are indexed by schema via the action's schema field.
    // For now, match rules to schemas via the action trigger name convention: "schema.action_name"
    const actionNames = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
    const schemas: string[] = [];
    for (const name of actionNames) {
      const dotIdx = name.indexOf(".");
      if (dotIdx > 0) {
        schemas.push(name.substring(0, dotIdx));
      }
    }
    return schemas;
  }

  if ("stateChange" in trigger) {
    return [trigger.stateChange.schema];
  }

  if ("fieldChange" in trigger) {
    return [trigger.fieldChange.schema];
  }

  return [];
}

/** Extract schema names from a flow's action steps */
function extractSchemasFromFlow(
  flow: FlowDefinition,
  actionsBySchema: Map<string, ActionDefinition[]>,
): Set<string> {
  const schemas = new Set<string>();

  // Build reverse index: action name → schema
  const actionToSchema = new Map<string, string>();
  for (const [schema, actions] of actionsBySchema) {
    for (const action of actions) {
      actionToSchema.set(action.name, schema);
    }
  }

  for (const step of flow.steps) {
    if (step.type === "action") {
      const schema = actionToSchema.get(step.actionName);
      if (schema) schemas.add(schema);
    }
  }

  // Also check trigger events
  if (flow.trigger.type === "event") {
    // Convention: event names like "purchase_request.submit.succeeded"
    const parts = flow.trigger.eventType.split(".");
    const schemaName = parts[0];
    if (parts.length >= 2 && schemaName) {
      schemas.add(schemaName);
    }
  }

  return schemas;
}

/** Extract schema names from an event handler's listen field */
function extractSchemasFromHandler(
  handler: EventHandlerDefinition,
  schemaRegistry: SchemaRegistryLike,
): string[] {
  const listen = Array.isArray(handler.listen) ? handler.listen : [handler.listen];
  const schemas: string[] = [];

  for (const eventType of listen) {
    // Convention: event names like "purchase_request.submit.succeeded"
    const parts = eventType.split(".");
    const schemaName = parts[0];
    if (parts.length >= 2 && schemaName && schemaRegistry.has(schemaName)) {
      schemas.push(schemaName);
    }
  }

  return schemas;
}
