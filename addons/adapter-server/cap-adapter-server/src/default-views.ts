/**
 * Generate default list and form views for schemas that have no explicitly defined views.
 *
 * Avoids duplicating fallback logic on the client side — the server provides
 * sensible defaults so the UI always receives usable view definitions.
 */

import type {
  FormLayoutNode,
  EntityDefinition,
  ViewAction,
  ViewDefinition,
  ViewFieldConfig,
} from "@linchkit/core";

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

/** Field types that benefit from full-width display (single column). */
const WIDE_FIELD_TYPES = new Set(["text", "json", "html", "richtext"]);

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
function getNonSystemFields(entity: EntityDefinition): string[] {
  return Object.keys(entity.fields).filter((f) => !SYSTEM_FIELD_NAMES.has(f));
}

/**
 * Generate a default list view for a schema.
 */
function generateDefaultListView(entity: EntityDefinition): ViewDefinition {
  const allFields = getNonSystemFields(entity);

  // Prefer summaryFields if available, otherwise take first N fields
  let listFields: string[];
  if (entity.presentation?.summaryFields?.length) {
    listFields = entity.presentation.summaryFields.filter(
      (f) => f in entity.fields && !SYSTEM_FIELD_NAMES.has(f),
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
    { action: `create_${entity.name}`, label: "Create", variant: "default" },
  ];

  return {
    name: `${entity.name}_list_default`,
    entity: entity.name,
    type: "list",
    label: `${entity.label ?? entity.name} List`,
    fields: toViewFields(listFields),
    actions,
  };
}

/**
 * Generate a default form view for a schema.
 *
 * Produces a two-column layout matching the client-side fallback:
 * - Short fields (string, number, boolean, enum, state, date, ref) split into left/right groups
 * - Wide fields (text, json, html, richtext) placed full-width below the columns
 */
function generateDefaultFormView(entity: EntityDefinition): ViewDefinition {
  const formFields = getNonSystemFields(entity);

  const actions: ViewAction[] = [
    { action: `create_${entity.name}`, label: "Create", position: "form-header" },
    { action: `update_${entity.name}`, label: "Save", position: "form-header" },
  ];

  // Partition fields into short (two-column) and wide (full-width)
  const shortFields: string[] = [];
  const wideFields: string[] = [];
  for (const name of formFields) {
    const fieldType = entity.fields[name]?.type;
    if (fieldType && WIDE_FIELD_TYPES.has(fieldType)) {
      wideFields.push(name);
    } else {
      shortFields.push(name);
    }
  }

  // Split short fields evenly into left and right columns
  const mid = Math.ceil(shortFields.length / 2);
  const leftFields = shortFields.slice(0, mid);
  const rightFields = shortFields.slice(mid);

  const layoutNodes: FormLayoutNode[] = [];

  // Top-level group with two inner groups for the two-column layout
  if (shortFields.length > 0) {
    layoutNodes.push({
      type: "group",
      children: [
        {
          type: "group",
          children: leftFields.map((f) => ({ type: "field" as const, field: f })),
        },
        {
          type: "group",
          children: rightFields.map((f) => ({ type: "field" as const, field: f })),
        },
      ],
    });
  }

  // Wide fields in a single-column group below
  if (wideFields.length > 0) {
    layoutNodes.push({
      type: "group",
      columns: 1,
      children: wideFields.map((f) => ({ type: "field" as const, field: f })),
    });
  }

  return {
    name: `${entity.name}_form_default`,
    entity: entity.name,
    type: "form",
    label: `${entity.label ?? entity.name} Form`,
    fields: toViewFields(formFields),
    layout: layoutNodes.length > 0 ? { nodes: layoutNodes } : undefined,
    actions,
  };
}

/**
 * Generate default list and form views for a schema.
 *
 * Returns a record keyed by view name, suitable for merging into the
 * schema metadata response.
 */
export function generateDefaultViews(entity: EntityDefinition): Record<string, ViewDefinition> {
  const list = generateDefaultListView(entity);
  const form = generateDefaultFormView(entity);
  return {
    [list.name]: list,
    [form.name]: form,
  };
}
