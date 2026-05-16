/**
 * Project Documentation Generator
 *
 * Walks the OntologyRegistry to produce a structured project-wide doc
 * object with top-level entries for every meta-model artifact:
 * Entities, Actions, Rules, State Machines, Views, Flows, Relations,
 * Events, and Event Handlers.
 *
 * Output is deterministic — entities and other top-level lists are sorted
 * alphabetically; per-entity nested lists (fields, actions, etc.) preserve
 * definition order to keep semantically meaningful ordering visible.
 *
 * Pair with `renderProjectDoc` (see `./project-doc-renderer`) to obtain
 * deterministic Markdown for `linch docs` — see spec 25 §2.1.
 */

import type {
  EventDefinition,
  EventHandlerDefinition,
  FlowDefinition,
  OntologyRegistry,
  RelationDefinition,
  RuleDefinition,
  StateDefinition,
  ViewDefinition,
} from "@linchkit/core";
import type { EntityDoc } from "./api-doc-generator";
import { entityToDoc } from "./api-doc-generator";

// -- Project doc types -------------------------------------------------

/** Documentation for a single rule */
export interface ProjectRuleDoc {
  name: string;
  label: string;
  description?: string;
  triggerSummary: string;
  effectSummary: string;
}

/** Documentation for a single state machine */
export interface ProjectStateMachineDoc {
  name: string;
  entity: string;
  initial: string;
  states: string[];
  transitions: Array<{ from: string | string[]; to: string; action: string }>;
}

/** Documentation for a single view */
export interface ProjectViewDoc {
  name: string;
  entity: string;
  type: string;
  label?: string;
  description?: string;
}

/** Documentation for a single flow */
export interface ProjectFlowDoc {
  name: string;
  label?: string;
  description?: string;
  triggerSummary: string;
  stepCount: number;
  stepNames: string[];
  onError?: string;
}

/** Documentation for a single event */
export interface ProjectEventDoc {
  name: string;
  label?: string;
  description?: string;
  payloadKeys: string[];
}

/** Documentation for a single event handler */
export interface ProjectEventHandlerDoc {
  name: string;
  label?: string;
  description?: string;
  listen: string[];
  async: boolean;
  priority?: number;
}

/** Documentation for a single relation */
export interface ProjectRelationDoc {
  name: string;
  from: string;
  to: string;
  cardinality: string;
  fromName: string;
  toName: string;
  description?: string;
  cascade?: string;
  required?: boolean;
}

/** Full project documentation */
export interface ProjectDoc {
  title: string;
  description?: string;
  generatedAt: string;
  entities: EntityDoc[];
  rules: ProjectRuleDoc[];
  stateMachines: ProjectStateMachineDoc[];
  views: ProjectViewDoc[];
  flows: ProjectFlowDoc[];
  relations: ProjectRelationDoc[];
  events: ProjectEventDoc[];
  eventHandlers: ProjectEventHandlerDoc[];
}

// -- Generator inputs -------------------------------------------------

export interface ProjectDocGeneratorOptions {
  /** Title for the generated documentation */
  title?: string;
  /** Description for the generated documentation */
  description?: string;
  /**
   * Override the timestamp emitted in the document. When omitted, the
   * current ISO timestamp is used. Tests pass a fixed value so the output
   * stays byte-stable.
   */
  generatedAt?: string;
  /** All rules (top-level — typically union of cap.rules). */
  rules?: RuleDefinition[];
  /** All state machines. */
  states?: StateDefinition[];
  /** All views. */
  views?: ViewDefinition[];
  /** All flows. */
  flows?: FlowDefinition[];
  /** All relation definitions. */
  relations?: RelationDefinition[];
  /** All custom events. */
  events?: EventDefinition[];
  /** All event handlers. */
  eventHandlers?: EventHandlerDefinition[];
}

// -- Generator -------------------------------------------------

/**
 * Generate a structured project document by walking the OntologyRegistry
 * for entities (which include their actions) and combining the supplied
 * top-level definition arrays for the remaining artifact types.
 */
export function generateProjectDoc(
  ontology: OntologyRegistry,
  options: ProjectDocGeneratorOptions = {},
): ProjectDoc {
  // Sort entity names alphabetically for deterministic output.
  const entityNames = [...ontology.listEntities()].sort();
  const entities: EntityDoc[] = [];

  for (const name of entityNames) {
    const descriptor = ontology.describe(name);
    if (!descriptor) continue;
    entities.push(entityToDoc(descriptor));
  }

  const rules = (options.rules ?? []).map(ruleToDoc).sort((a, b) => a.name.localeCompare(b.name));

  const stateMachines = (options.states ?? [])
    .map(stateToDoc)
    .sort((a, b) => a.name.localeCompare(b.name));

  const views = (options.views ?? []).map(viewToDoc).sort((a, b) => a.name.localeCompare(b.name));

  const flows = (options.flows ?? []).map(flowToDoc).sort((a, b) => a.name.localeCompare(b.name));

  const relations = (options.relations ?? [])
    .map(relationToDoc)
    .sort((a, b) => a.name.localeCompare(b.name));

  const events = (options.events ?? [])
    .map(eventToDoc)
    .sort((a, b) => a.name.localeCompare(b.name));

  const eventHandlers = (options.eventHandlers ?? [])
    .map(eventHandlerToDoc)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    title: options.title ?? "Project Documentation",
    description: options.description,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    entities,
    rules,
    stateMachines,
    views,
    flows,
    relations,
    events,
    eventHandlers,
  };
}

// -- Per-artifact converters -------------------------------------------

function ruleToDoc(rule: RuleDefinition): ProjectRuleDoc {
  return {
    name: rule.name,
    label: rule.label,
    description: rule.description,
    triggerSummary: summarizeRuleTrigger(rule),
    effectSummary: summarizeRuleEffect(rule),
  };
}

function summarizeRuleTrigger(rule: RuleDefinition): string {
  const t = rule.trigger;
  if ("action" in t) {
    const list = Array.isArray(t.action) ? t.action.join(", ") : t.action;
    return `action: ${list}`;
  }
  if ("stateChange" in t) {
    const sc = t.stateChange;
    const parts = [`entity=${sc.entity}`];
    if (sc.from) parts.push(`from=${sc.from}`);
    if (sc.to) parts.push(`to=${sc.to}`);
    return `stateChange (${parts.join(", ")})`;
  }
  if ("fieldChange" in t) {
    return `fieldChange (entity=${t.fieldChange.entity}, field=${t.fieldChange.field})`;
  }
  if ("event" in t) {
    return `event: ${t.event}`;
  }
  if ("schedule" in t) {
    return `schedule: ${t.schedule}`;
  }
  return "unknown";
}

function summarizeRuleEffect(rule: RuleDefinition): string {
  const e = rule.effect;
  switch (e.type) {
    case "block":
      return `block: ${e.message}`;
    case "warn":
      return `warn: ${e.message}`;
    case "require_approval":
      return `require_approval (level=${e.level})`;
    case "enrich":
      return `enrich (${Object.keys(e.setFields).join(", ")})`;
    case "execute_action":
      return `execute_action: ${e.action}`;
    default:
      return "unknown";
  }
}

function stateToDoc(state: StateDefinition): ProjectStateMachineDoc {
  return {
    name: state.name,
    entity: state.entity,
    initial: state.initial,
    states: [...state.states],
    transitions: state.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      action: t.action,
    })),
  };
}

function viewToDoc(view: ViewDefinition): ProjectViewDoc {
  return {
    name: view.name,
    entity: view.entity,
    type: view.type,
    label: view.label,
    description: view.description,
  };
}

function flowToDoc(flow: FlowDefinition): ProjectFlowDoc {
  const trigger = flow.trigger;
  let triggerSummary = "manual";
  if (trigger.type === "event") {
    triggerSummary = `event: ${trigger.eventType}`;
  } else if (trigger.type === "schedule") {
    triggerSummary = `schedule: ${trigger.cron}`;
  } else if (trigger.type === "manual") {
    triggerSummary = "manual";
  }

  const stepNames = flow.steps.map((s) => `${s.id}(${s.type})`);

  return {
    name: flow.name,
    label: flow.label,
    description: flow.description,
    triggerSummary,
    stepCount: flow.steps.length,
    stepNames,
    onError: flow.onError ?? flow.failurePolicy,
  };
}

function eventToDoc(event: EventDefinition): ProjectEventDoc {
  return {
    name: event.name,
    label: event.label,
    description: event.description,
    payloadKeys: event.payload ? Object.keys(event.payload).sort() : [],
  };
}

function eventHandlerToDoc(handler: EventHandlerDefinition): ProjectEventHandlerDoc {
  return {
    name: handler.name,
    label: handler.label,
    description: handler.description,
    listen: Array.isArray(handler.listen) ? [...handler.listen] : [handler.listen],
    async: handler.async ?? false,
    priority: handler.priority,
  };
}

function relationToDoc(rel: RelationDefinition): ProjectRelationDoc {
  return {
    name: rel.name,
    from: rel.from,
    to: rel.to,
    cardinality: rel.cardinality,
    fromName: rel.fromName,
    toName: rel.toName,
    description: rel.description,
    cascade: rel.cascade,
    required: rel.required,
  };
}
