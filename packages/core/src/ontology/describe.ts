/**
 * Describe helpers — project introspection for developers and AI tools
 *
 * Builds structured overviews of a LinchKit project's meta-model from
 * capability definitions without requiring a running server or database.
 */

import { resolveLabel } from "../i18n/label-resolver";
import type { ActionDefinition } from "../types/action";
import type { EntityDefinition, FieldDefinition } from "../types/entity";
import type { FlowDefinition } from "../types/flow";
import type { RelationDefinition } from "../types/relation";
import type { RuleDefinition } from "../types/rule";
import type { StateDefinition, Transition } from "../types/state";
import type { ViewDefinition } from "../types/view";

// ── Overview ────────────────────────────────────────────

export interface ProjectOverview {
  capabilities: { name: string; type: string; version: string }[];
  entities: { name: string; fieldCount: number; label?: string }[];
  actions: { name: string; entity: string; label: string }[];
  rules: { name: string; label: string }[];
  states: { name: string; entity: string; stateCount: number }[];
  flows: { name: string; label?: string }[];
  relations: { name: string; from: string; to: string; type: string }[];
}

// ── Entity description ──────────────────────────────────

export interface FieldDescription {
  name: string;
  type: string;
  required: boolean;
  system: boolean;
  label?: string;
  constraints?: Record<string, unknown>;
}

export interface EntityDescription {
  name: string;
  label?: string;
  description?: string;
  fields: FieldDescription[];
  actions: { name: string; label: string }[];
  states?: {
    name: string;
    states: string[];
    initial: string;
    transitions: Transition[];
  };
  relations: { name: string; direction: string; target: string; cardinality: string }[];
  views: { name: string; type: string }[];
}

// ── Action description ──────────────────────────────────

export interface ActionDescription {
  name: string;
  entity: string;
  label: string;
  description?: string;
  input: FieldDescription[];
  output: FieldDescription[];
  stateTransition?: { from: string | string[]; to: string };
  effects: string[];
}

// ── Relation description ────────────────────────────────

export interface RelationDescription {
  name: string;
  from: string;
  to: string;
  cardinality: string;
  description?: string;
  label?: { from?: string; to?: string };
  required: boolean;
  cascade: string;
  properties: FieldDescription[];
}

// ── System field names ──────────────────────────────────

const SYSTEM_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "_extensions",
]);

// ── Helpers ─────────────────────────────────────────────

function describeField(name: string, field: FieldDefinition): FieldDescription {
  const desc: FieldDescription = {
    name,
    type: field.type,
    required: !!field.required,
    system: SYSTEM_FIELDS.has(name),
  };
  if (field.label) desc.label = resolveLabel(field.label, name);

  // Collect constraints (FieldDefinition is a union — use 'in' narrowing)
  const constraints: Record<string, unknown> = {};
  if ("min" in field && field.min !== undefined) constraints.min = field.min;
  if ("max" in field && field.max !== undefined) constraints.max = field.max;
  if ("minLength" in field && field.minLength !== undefined)
    constraints.minLength = field.minLength;
  if ("maxLength" in field && field.maxLength !== undefined)
    constraints.maxLength = field.maxLength;
  if ("pattern" in field && field.pattern) constraints.pattern = field.pattern;
  if ("enum" in field && field.enum) constraints.enum = field.enum;
  if (Object.keys(constraints).length > 0) desc.constraints = constraints;

  return desc;
}

// ── Build overview ──────────────────────────────────────

export interface DescribeInput {
  capabilities: {
    name: string;
    type: string;
    version: string;
    entities?: EntityDefinition[];
    actions?: ActionDefinition[];
    rules?: RuleDefinition[];
    states?: StateDefinition[];
    flows?: FlowDefinition[];
    relations?: RelationDefinition[];
    views?: ViewDefinition[];
  }[];
}

/**
 * Build a high-level overview of the project's meta-model.
 */
export function buildProjectOverview(input: DescribeInput): ProjectOverview {
  const allEntities: EntityDefinition[] = [];
  const allActions: ActionDefinition[] = [];
  const allRules: RuleDefinition[] = [];
  const allStates: StateDefinition[] = [];
  const allFlows: FlowDefinition[] = [];
  const allRelations: RelationDefinition[] = [];

  for (const cap of input.capabilities) {
    if (cap.entities) allEntities.push(...cap.entities);
    if (cap.actions) allActions.push(...cap.actions);
    if (cap.rules) allRules.push(...cap.rules);
    if (cap.states) allStates.push(...cap.states);
    if (cap.flows) allFlows.push(...cap.flows);
    if (cap.relations) allRelations.push(...cap.relations);
  }

  return {
    capabilities: input.capabilities.map((c) => ({
      name: c.name,
      type: c.type,
      version: c.version,
    })),
    entities: allEntities.map((e) => ({
      name: e.name,
      fieldCount: Object.keys(e.fields).length,
      label: resolveLabel(e.label, e.name),
    })),
    actions: allActions.map((a) => ({
      name: a.name,
      entity: a.entity,
      label: resolveLabel(a.label, a.name),
    })),
    rules: allRules.map((r) => ({
      name: r.name,
      label: resolveLabel(r.label, r.name),
    })),
    states: allStates.map((s) => ({
      name: s.name,
      entity: s.entity,
      stateCount: s.states.length,
    })),
    flows: allFlows.map((f) => ({
      name: f.name,
      label: f.label ? resolveLabel(f.label, f.name) : undefined,
    })),
    relations: allRelations.map((l) => ({
      name: l.name,
      from: l.from,
      to: l.to,
      type: l.cardinality,
    })),
  };
}

/**
 * Build a detailed description of a single entity.
 */
export function describeEntity(
  entity: EntityDefinition,
  opts: {
    actions?: ActionDefinition[];
    states?: StateDefinition[];
    relations?: RelationDefinition[];
    views?: ViewDefinition[];
  } = {},
): EntityDescription {
  const fields = Object.entries(entity.fields).map(([name, field]) => describeField(name, field));

  const entityActions = (opts.actions ?? [])
    .filter((a) => a.entity === entity.name)
    .map((a) => ({ name: a.name, label: resolveLabel(a.label, a.name) }));

  const state = (opts.states ?? []).find((s) => s.entity === entity.name);
  const stateDesc = state
    ? {
        name: state.name,
        states: [...state.states],
        initial: state.initial,
        transitions: state.transitions,
      }
    : undefined;

  const relations = (opts.relations ?? [])
    .filter((l) => l.from === entity.name || l.to === entity.name)
    .map((l) => ({
      name: l.name,
      direction: l.from === entity.name ? "outgoing" : "incoming",
      target: l.from === entity.name ? l.to : l.from,
      cardinality: l.cardinality,
    }));

  const views = (opts.views ?? [])
    .filter((v) => v.entity === entity.name)
    .map((v) => ({ name: v.name, type: v.type }));

  return {
    name: entity.name,
    label: resolveLabel(entity.label, entity.name),
    description: entity.description,
    fields,
    actions: entityActions,
    states: stateDesc,
    relations,
    views,
  };
}

/**
 * Build a detailed description of a single action.
 */
export function describeAction(action: ActionDefinition): ActionDescription {
  const input = action.input
    ? Object.entries(action.input).map(([name, field]) => describeField(name, field))
    : [];

  const output = action.output
    ? Object.entries(action.output).map(([name, field]) => describeField(name, field))
    : [];

  const effects: string[] = [];
  if (action.stateTransition) {
    const from = Array.isArray(action.stateTransition.from)
      ? action.stateTransition.from.join("|")
      : action.stateTransition.from;
    effects.push(`State: ${from} -> ${action.stateTransition.to}`);
  }
  if (action.setFields) {
    effects.push(`Sets fields: ${Object.keys(action.setFields).join(", ")}`);
  }

  return {
    name: action.name,
    entity: action.entity,
    label: resolveLabel(action.label, action.name),
    description: action.description,
    input,
    output,
    stateTransition: action.stateTransition
      ? { from: action.stateTransition.from, to: action.stateTransition.to }
      : undefined,
    effects,
  };
}

/**
 * Build a detailed description of a single relation.
 */
export function describeRelation(relation: RelationDefinition): RelationDescription {
  const properties = relation.properties
    ? Object.entries(relation.properties).map(([name, field]) => describeField(name, field))
    : [];

  return {
    name: relation.name,
    from: relation.from,
    to: relation.to,
    cardinality: relation.cardinality,
    description: relation.description,
    label: relation.label,
    required: !!relation.required,
    cascade: relation.cascade ?? "none",
    properties,
  };
}
