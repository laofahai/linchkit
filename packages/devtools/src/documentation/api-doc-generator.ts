/**
 * API Documentation Generator
 *
 * Generates structured documentation from registered schemas, actions, and ontology.
 * Produces intermediate doc objects that renderers (Markdown, OpenAPI) consume.
 */

import type {
  ActionDefinition,
  ActionExposure,
  FieldDefinition,
  OntologyRegistry,
  RelationDescriptor,
  EntityDescriptor,
} from "@linchkit/core";

// -- Structured doc types -------------------------------------------------

/** Documentation for a single field */
export interface FieldDoc {
  name: string;
  type: string;
  label: string;
  description?: string;
  required: boolean;
  constraints: Record<string, unknown>;
  /** Target schema for ref/has_many/many_to_many */
  target?: string;
  /** Enum options for enum fields */
  options?: Array<{ value: string; label?: string }>;
  /** State machine name for state fields */
  machine?: string;
}

/** Documentation for a single action */
export interface ActionDoc {
  name: string;
  schema: string;
  label: string;
  description?: string;
  input: FieldDoc[];
  output: FieldDoc[];
  stateTransition?: { from: string | string[]; to: string };
  exposure: ActionExposure;
  permissions?: { groups?: string[]; actorTypes?: string[] };
  policy: { mode: string; transaction: boolean; idempotent?: boolean };
}

/** Documentation for a schema */
export interface SchemaDoc {
  name: string;
  label: string;
  description?: string;
  fields: FieldDoc[];
  actions: ActionDoc[];
  relations: RelationDescriptor[];
  stateMachine?: {
    name: string;
    initial: string;
    states: string[];
    transitions: Array<{ from: string | string[]; to: string; action: string }>;
  };
}

/** Full system documentation */
export interface SystemDoc {
  title: string;
  description?: string;
  generatedAt: string;
  schemas: SchemaDoc[];
}

// -- Field doc extraction -------------------------------------------------

/** Convert a FieldDefinition to a FieldDoc */
export function fieldToDoc(name: string, field: FieldDefinition): FieldDoc {
  const constraints: Record<string, unknown> = {};
  if (field.min !== undefined) constraints.min = field.min;
  if (field.max !== undefined) constraints.max = field.max;
  if (field.unique) constraints.unique = true;
  if (field.format) constraints.format = field.format;
  if (field.immutable) constraints.immutable = true;

  const doc: FieldDoc = {
    name,
    type: field.type,
    label: field.label ?? name,
    description: field.description,
    required: field.required ?? false,
    constraints,
  };

  // Type-specific properties
  if (field.type === "ref" || field.type === "has_many" || field.type === "many_to_many") {
    doc.target = field.target;
  }
  if (field.type === "enum") {
    doc.options = field.options;
  }
  if (field.type === "state") {
    doc.machine = field.machine;
  }

  return doc;
}

/** Convert an ActionDefinition to an ActionDoc */
export function actionToDoc(action: ActionDefinition): ActionDoc {
  const inputFields: FieldDoc[] = action.input
    ? Object.entries(action.input).map(([name, field]) => fieldToDoc(name, field))
    : [];

  const outputFields: FieldDoc[] = action.output
    ? Object.entries(action.output).map(([name, field]) => fieldToDoc(name, field))
    : [];

  // Normalize exposure
  let exposure: ActionExposure;
  if (action.exposure === "all") {
    exposure = { http: true, mcp: true, cli: true, ui: true, internal: true };
  } else {
    exposure = action.exposure ?? {};
  }

  return {
    name: action.name,
    schema: action.schema,
    label: action.label,
    description: action.description,
    input: inputFields,
    output: outputFields,
    stateTransition: action.stateTransition,
    exposure,
    permissions: action.permissions
      ? { groups: action.permissions.groups, actorTypes: action.permissions.actorTypes }
      : undefined,
    policy: {
      mode: action.policy.mode,
      transaction: action.policy.transaction,
      idempotent: action.policy.idempotent,
    },
  };
}

/** Convert a EntityDescriptor to a SchemaDoc */
export function schemaToDoc(descriptor: EntityDescriptor): SchemaDoc {
  const fields = Object.entries(descriptor.fields).map(([name, field]) => fieldToDoc(name, field));

  const actions = descriptor.actions.map(actionToDoc);

  const stateMachine = descriptor.states
    ? {
        name: descriptor.states.name,
        initial: descriptor.states.initial,
        states: [...descriptor.states.states],
        transitions: descriptor.states.transitions.map((t) => ({
          from: t.from,
          to: t.to,
          action: t.action,
        })),
      }
    : undefined;

  return {
    name: descriptor.name,
    label: descriptor.label ?? descriptor.name,
    description: descriptor.description,
    fields,
    actions,
    relations: descriptor.relations,
    stateMachine,
  };
}

// -- ApiDocGenerator -------------------------------------------------

export interface ApiDocGeneratorOptions {
  /** Title for the generated documentation */
  title?: string;
  /** Description for the generated documentation */
  description?: string;
}

/**
 * Generate structured documentation from an OntologyRegistry.
 *
 * Returns a SystemDoc that can be rendered to Markdown, OpenAPI, etc.
 */
export function generateApiDoc(
  ontology: OntologyRegistry,
  options?: ApiDocGeneratorOptions,
): SystemDoc {
  const schemaNames = ontology.listEntities();
  const schemas: SchemaDoc[] = [];

  for (const name of schemaNames) {
    const descriptor = ontology.describe(name);
    if (!descriptor) continue;
    schemas.push(schemaToDoc(descriptor));
  }

  return {
    title: options?.title ?? "API Documentation",
    description: options?.description,
    generatedAt: new Date().toISOString(),
    schemas,
  };
}
