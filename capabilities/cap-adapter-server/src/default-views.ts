/**
 * Generate default list and form views for schemas that have no explicitly defined views.
 *
 * Avoids duplicating fallback logic on the client side — the server provides
 * sensible defaults so the UI always receives usable view definitions.
 */

import type { SchemaDefinition, ViewDefinition, ViewFieldConfig, ViewAction } from "@linchkit/core";

/** System fields excluded from auto-generated views */
const SYSTEM_FIELD_NAMES = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "is_deleted",
]);

/** Maximum number of fields shown in a default list view */
const MAX_LIST_FIELDS = 6;

/**
 * Build a ViewFieldConfig array from schema field names.
 */
function toViewFields(fieldNames: string[]): ViewFieldConfig[] {
  return fieldNames.map((field) => ({ field }));
}

/**
 * Get non-system field names from a schema in definition order.
 */
function getNonSystemFields(schema: SchemaDefinition): string[] {
  return Object.keys(schema.fields).filter((f) => !SYSTEM_FIELD_NAMES.has(f));
}

/**
 * Generate a default list view for a schema.
 */
function generateDefaultListView(schema: SchemaDefinition): ViewDefinition {
  const allFields = getNonSystemFields(schema);

  // Prefer summaryFields if available, otherwise take first N fields
  let listFields: string[];
  if (schema.presentation?.summaryFields?.length) {
    listFields = schema.presentation.summaryFields.filter(
      (f) => f in schema.fields && !SYSTEM_FIELD_NAMES.has(f),
    );
    // If summaryFields didn't yield enough, pad with remaining fields
    if (listFields.length < MAX_LIST_FIELDS) {
      const remaining = allFields.filter((f) => !listFields.includes(f));
      listFields = listFields.concat(remaining.slice(0, MAX_LIST_FIELDS - listFields.length));
    }
  } else {
    listFields = allFields.slice(0, MAX_LIST_FIELDS);
  }

  const actions: ViewAction[] = [
    { action: `create_${schema.name}`, label: "Create", variant: "default" },
  ];

  return {
    name: `${schema.name}_list_default`,
    schema: schema.name,
    type: "list",
    label: `${schema.label ?? schema.name} List`,
    fields: toViewFields(listFields),
    actions,
  };
}

/**
 * Generate a default form view for a schema.
 */
function generateDefaultFormView(schema: SchemaDefinition): ViewDefinition {
  const formFields = getNonSystemFields(schema);

  const actions: ViewAction[] = [
    { action: `create_${schema.name}`, label: "Create", position: "form-header" },
    { action: `update_${schema.name}`, label: "Save", position: "form-header" },
  ];

  return {
    name: `${schema.name}_form_default`,
    schema: schema.name,
    type: "form",
    label: `${schema.label ?? schema.name} Form`,
    fields: toViewFields(formFields),
    actions,
  };
}

/**
 * Generate default list and form views for a schema.
 *
 * Returns a record keyed by view name, suitable for merging into the
 * schema metadata response.
 */
export function generateDefaultViews(
  schema: SchemaDefinition,
): Record<string, ViewDefinition> {
  const list = generateDefaultListView(schema);
  const form = generateDefaultFormView(schema);
  return {
    [list.name]: list,
    [form.name]: form,
  };
}
