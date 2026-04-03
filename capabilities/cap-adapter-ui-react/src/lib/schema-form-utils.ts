/**
 * Utility functions for SchemaFormPage.
 *
 * Pure functions extracted from schema-form.tsx to reduce component size.
 */

import type {
  FormLayoutNode,
  SchemaDefinition,
  StateDefinition,
  StateMeta,
  ViewDefinition,
} from "@linchkit/core/types";
import type { StatusBarStep } from "../components/status-bar";

/** Derive StatusBar steps from state machine meta in schema presentation */
export function deriveStatusSteps(
  schema: SchemaDefinition,
  states?: StateDefinition[],
  resolve?: (label: string | undefined, fallback: string) => string,
): StatusBarStep[] | null {
  const stateFieldEntry = Object.entries(schema.fields).find(([, f]) => f.type === "state");
  if (!stateFieldEntry) return null;

  const [, stateField] = stateFieldEntry;
  if (!("machine" in stateField)) return null;

  const machine = (states ?? []).find(
    (s) => s.name === stateField.machine && s.schema === schema.name,
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
  schema: SchemaDefinition,
  states: StateDefinition[] | undefined,
  currentState: string,
): Set<string> | null {
  const stateFieldEntry = Object.entries(schema.fields).find(([, f]) => f.type === "state");
  if (!stateFieldEntry) return null;

  const [, stateField] = stateFieldEntry;
  if (!("machine" in stateField)) return null;

  const machine = (states ?? []).find(
    (s) => s.name === stateField.machine && s.schema === schema.name,
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

/** Relationship field types that require subfield selection in GraphQL */
const RELATION_FIELD_TYPES = new Set(["ref", "has_many", "many_to_many"]);

/** has_many / many_to_many are only available on query types, not mutation return types */
const COLLECTION_RELATION_TYPES = new Set(["has_many", "many_to_many"]);

/** Extract GraphQL field names from view fields, always including the state field */
export function getRecordFields(view: ViewDefinition, schema?: SchemaDefinition): string[] {
  const fields = new Set<string>(["id"]);
  for (const f of view.fields) {
    if (f.field.includes(".")) continue;
    const fieldDef = schema?.fields?.[f.field];
    if (fieldDef && RELATION_FIELD_TYPES.has(fieldDef.type ?? "")) {
      // Include display fields so the UI can show a human-readable label
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
 * Excludes has_many/many_to_many fields which are only available on query types,
 * not on create/update mutation return types.
 */
export function getMutationReturnFields(
  recordFields: string[],
  schema?: SchemaDefinition,
): string[] {
  if (!schema) return recordFields;
  return recordFields.filter((f) => {
    // Extract field name from "fieldName { subfields }" format
    const fieldName = f.split(" ")[0] ?? f;
    const fieldDef = schema.fields[fieldName];
    if (!fieldDef) return true;
    return !COLLECTION_RELATION_TYPES.has(fieldDef.type ?? "");
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
    schema: schema.name,
    type: "form",
    label: schema.label ?? schema.name,
    fields,
    layout: layoutNodes.length > 0 ? { nodes: layoutNodes } : undefined,
    actions: [],
  };
}

/** Field types excluded from child-record form views (relation back-refs, state, derived) */
const CHILD_EXCLUDED_TYPES = new Set(["ref", "has_many", "many_to_many", "state", "computed"]);

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
    schema: schema.name,
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
