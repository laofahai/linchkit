/**
 * Utility functions for SchemaFormPage.
 *
 * Pure functions extracted from schema-form.tsx to reduce component size.
 */

import type {
  EntityDefinition,
  FormLayoutNode,
  RelationDefinition,
  StateDefinition,
  StateMeta,
  ViewDefinition,
} from "@linchkit/core/types";
import type { StatusBarStep } from "../components/status-bar";

/** Derive StatusBar steps from state machine meta in schema presentation */
export function deriveStatusSteps(
  schema: EntityDefinition,
  states?: StateDefinition[],
  resolve?: (label: string | undefined, fallback: string) => string,
): StatusBarStep[] | null {
  const stateFieldEntry = Object.entries(schema.fields).find(([, f]) => f.type === "state");
  if (!stateFieldEntry) return null;

  const [, stateField] = stateFieldEntry;
  if (!("machine" in stateField)) return null;

  const machine = (states ?? []).find(
    (s) => s.name === stateField.machine && s.entity === schema.name,
  );
  if (!machine) return null;

  const steps: StatusBarStep[] = machine.states.map((stateValue) => {
    const meta: StateMeta | undefined = machine.meta?.[stateValue];
    const rawLabel = meta?.label ?? stateValue;
    const label = resolve ? resolve(rawLabel, stateValue) : rawLabel;
    return { value: stateValue, label, color: meta?.color };
  });

  return steps.length > 0 ? steps : null;
}

/**
 * Get the set of action names that are valid transitions from the current state.
 */
export function getTransitionActionNames(
  schema: EntityDefinition,
  states: StateDefinition[] | undefined,
  currentState: string,
): Set<string> | null {
  const stateFieldEntry = Object.entries(schema.fields).find(([, f]) => f.type === "state");
  if (!stateFieldEntry) return null;

  const [, stateField] = stateFieldEntry;
  if (!("machine" in stateField)) return null;

  const machine = (states ?? []).find(
    (s) => s.name === stateField.machine && s.entity === schema.name,
  );
  if (!machine) return null;

  const actionNames = new Set<string>();
  for (const t of machine.transitions) {
    const sources: string[] = Array.isArray(t.from) ? t.from : [t.from];
    if (sources.includes(currentState)) {
      actionNames.add(t.action);
    }
  }
  return actionNames;
}

/**
 * Build a set of semantic relation field names for a given entity
 * from RelationDefinition[]. Used to determine which GraphQL fields
 * need subfield selection `{ id name }`.
 */
function buildRelationFieldSet(entityName: string, relations: RelationDefinition[]): Set<string> {
  const names = new Set<string>();
  for (const rel of relations) {
    if (rel.from === entityName) names.add(rel.fromName);
    if (rel.to === entityName) names.add(rel.toName);
  }
  return names;
}

/** Collection cardinalities excluded from mutation return types (one_to_many, many_to_many) */
const COLLECTION_CARDINALITIES = new Set(["one_to_many", "many_to_many"]);

/**
 * Build a set of semantic relation field names that represent collection relations
 * (one_to_many / many_to_many) for a given entity. These are excluded from mutation
 * return types because they are only available on query types.
 */
function buildCollectionRelationFields(
  entityName: string,
  relations: RelationDefinition[],
): Set<string> {
  const names = new Set<string>();
  for (const rel of relations) {
    const isFrom = rel.from === entityName;
    const isTo = rel.to === entityName;
    if (isFrom && COLLECTION_CARDINALITIES.has(rel.cardinality)) {
      names.add(rel.fromName);
    }
    if (isTo) {
      // Incoming side: many_to_one from-side appears as one_to_many on to-side
      const reverseCardinality =
        rel.cardinality === "many_to_one"
          ? "one_to_many"
          : rel.cardinality === "one_to_many"
            ? "many_to_one"
            : rel.cardinality;
      if (COLLECTION_CARDINALITIES.has(reverseCardinality)) {
        names.add(rel.toName);
      }
    }
  }
  return names;
}

/**
 * Extract GraphQL field names from view fields, always including the state field.
 * Relation fields are resolved from RelationDefinition[] metadata (Spec 61)
 * instead of entity field types.
 */
export function getRecordFields(
  view: ViewDefinition,
  schema?: EntityDefinition,
  relations?: RelationDefinition[],
): string[] {
  const fields = new Set<string>(["id"]);
  const entityName = schema?.name ?? "";
  const relationFields = relations
    ? buildRelationFieldSet(entityName, relations)
    : new Set<string>();

  for (const f of view.fields) {
    if (f.field.includes(".")) continue;
    if (relationFields.has(f.field)) {
      // Relation field — include display subfields for human-readable labels
      fields.add(`${f.field} { id name }`);
    } else {
      fields.add(f.field);
    }
  }
  if (schema) {
    const stateFieldName = Object.entries(schema.fields).find(([, f]) => f.type === "state")?.[0];
    if (stateFieldName) fields.add(stateFieldName);
  }
  return Array.from(fields);
}

/**
 * Filter record fields safe for mutation return types.
 * Excludes collection relation fields (one_to_many / many_to_many) which are
 * only available on query types, not on create/update mutation return types.
 */
export function getMutationReturnFields(
  recordFields: string[],
  schema?: EntityDefinition,
  relations?: RelationDefinition[],
): string[] {
  if (!schema || !relations) return recordFields;
  const entityName = schema.name;
  const collectionFields = buildCollectionRelationFields(entityName, relations);
  return recordFields.filter((f) => {
    // Extract field name from "fieldName { subfields }" format
    const fieldName = f.split(" ")[0] ?? f;
    return !collectionFields.has(fieldName);
  });
}

export function getPrimaryView<TView extends { type: string }>(
  views: Record<string, TView> | undefined,
  type: TView["type"],
): TView | undefined {
  return Object.values(views ?? {}).find((view) => view.type === type);
}

/** System-managed fields to exclude from auto-generated form views */
const SYSTEM_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "is_deleted",
]);

/** Field types that benefit from full-width display (single column) */
const WIDE_FIELD_TYPES = new Set(["text", "json", "html", "richtext"]);

/** Generate a minimal form view from schema fields when no explicit form view is defined */
export function generateFallbackFormView(schema: {
  name: string;
  label?: string;
  fields: Record<string, { label?: string; type?: string }>;
}): ViewDefinition {
  const fieldNames = Object.keys(schema.fields).filter((f) => !SYSTEM_FIELDS.has(f));

  const fields = fieldNames.map((field) => ({
    field,
    label: schema.fields[field]?.label,
  }));

  const shortFields: string[] = [];
  const wideFields: string[] = [];
  for (const name of fieldNames) {
    const fieldType = schema.fields[name]?.type;
    if (fieldType && WIDE_FIELD_TYPES.has(fieldType)) {
      wideFields.push(name);
    } else {
      shortFields.push(name);
    }
  }

  const mid = Math.ceil(shortFields.length / 2);
  const leftFields = shortFields.slice(0, mid);
  const rightFields = shortFields.slice(mid);

  const layoutNodes: FormLayoutNode[] = [];

  if (shortFields.length > 0) {
    layoutNodes.push({
      type: "group",
      children: [
        { type: "group", children: leftFields.map((f) => ({ type: "field" as const, field: f })) },
        { type: "group", children: rightFields.map((f) => ({ type: "field" as const, field: f })) },
      ],
    });
  }

  if (wideFields.length > 0) {
    layoutNodes.push({
      type: "group",
      columns: 1,
      children: wideFields.map((f) => ({ type: "field" as const, field: f })),
    });
  }

  return {
    name: `${schema.name}_form_auto`,
    entity: schema.name,
    type: "form",
    label: schema.label ?? schema.name,
    fields,
    layout: layoutNodes.length > 0 ? { nodes: layoutNodes } : undefined,
    actions: [],
  };
}

/** Field types excluded from child-record form views (state, derived) */
const CHILD_EXCLUDED_TYPES = new Set(["state", "computed"]);

/**
 * Generate a form view for child records in a has_many dialog.
 * Filters out system fields, relation back-references, state, and derived fields.
 */
export function generateChildFormView(schema: {
  name: string;
  label?: string;
  fields: Record<string, { label?: string; type?: string; derived?: unknown }>;
}): ViewDefinition {
  const fieldNames = Object.keys(schema.fields).filter((f) => {
    if (SYSTEM_FIELDS.has(f)) return false;
    const def = schema.fields[f];
    if (def?.type && CHILD_EXCLUDED_TYPES.has(def.type)) return false;
    if (def?.derived) return false;
    return true;
  });

  const fields = fieldNames.map((field) => ({
    field,
    label: schema.fields[field]?.label,
  }));

  const shortFields: string[] = [];
  const wideFields: string[] = [];
  for (const name of fieldNames) {
    const fieldType = schema.fields[name]?.type;
    if (fieldType && WIDE_FIELD_TYPES.has(fieldType)) {
      wideFields.push(name);
    } else {
      shortFields.push(name);
    }
  }

  const mid = Math.ceil(shortFields.length / 2);
  const leftFields = shortFields.slice(0, mid);
  const rightFields = shortFields.slice(mid);

  const layoutNodes: FormLayoutNode[] = [];

  if (shortFields.length > 0) {
    layoutNodes.push({
      type: "group",
      children: [
        { type: "group", children: leftFields.map((f) => ({ type: "field" as const, field: f })) },
        {
          type: "group",
          children: rightFields.map((f) => ({ type: "field" as const, field: f })),
        },
      ],
    });
  }

  if (wideFields.length > 0) {
    layoutNodes.push({
      type: "group",
      columns: 1,
      children: wideFields.map((f) => ({ type: "field" as const, field: f })),
    });
  }

  return {
    name: `${schema.name}_child_form_auto`,
    entity: schema.name,
    type: "form",
    label: schema.label ?? schema.name,
    fields,
    layout: layoutNodes.length > 0 ? { nodes: layoutNodes } : undefined,
    actions: [],
  };
}

/** Fields to strip when cloning a record */
export const CLONE_STRIP_FIELDS = new Set([
  "id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "tenant_id",
  "is_deleted",
]);
