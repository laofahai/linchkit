/**
 * Watcher-state system entity definition (Spec 45 §7.1).
 *
 * Registers the persisted watcher debounce state (`_linchkit.watcher_state`,
 * shipped by Spec 45 PR-2) as a read-only, queryable system entity so the
 * per-`(watcher_name, group_key)` condition state can be surfaced in the admin
 * automation management UI alongside the other system entities.
 *
 * Kept in this sibling module (rather than inlined in `system-schemas.ts`) to
 * avoid pushing the main file further past the ~500-line guideline; the
 * registration arrays still live in `system-schemas.ts`, which re-exports these.
 *
 * The underlying table is `watcherStateTable` from `@linchkit/cap-ai-provider`
 * (columns: watcher_name, group_key, last_fired_at, condition_met, tenant_id,
 * updated_at; composite PK `(watcher_name, group_key)` — no single `id`).
 */

import type { EntityDefinition, ViewDefinition } from "@linchkit/core";

// ── Watcher State ─────────────────────────────────────────

export const watcherStateSchema: EntityDefinition = {
  name: "watcher_state",
  label: "t:entities.watcher_state._label",
  description: "Persisted watcher debounce state per (watcher, group) for restart-safe firing",
  presentation: {
    titleField: "watcher_name",
    summaryFields: ["group_key", "condition_met", "last_fired_at"],
    icon: "radar",
  },
  fields: {
    watcher_name: {
      type: "string",
      required: true,
      label: "t:entities.watcher_state.fields.watcher_name",
      ui: { importance: "primary" },
    },
    group_key: {
      type: "string",
      required: true,
      label: "t:entities.watcher_state.fields.group_key",
      ui: { importance: "primary" },
    },
    last_fired_at: {
      type: "datetime",
      label: "t:entities.watcher_state.fields.last_fired_at",
    },
    condition_met: {
      type: "boolean",
      label: "t:entities.watcher_state.fields.condition_met",
    },
    tenant_id: {
      type: "string",
      label: "t:entities.watcher_state.fields.tenant_id",
    },
    updated_at: {
      type: "datetime",
      label: "t:entities.watcher_state.fields.updated_at",
    },
  },
};

export const watcherStateListView: ViewDefinition = {
  name: "watcher_state_list",
  entity: "watcher_state",
  type: "list",
  label: "t:entities.watcher_state._labelPlural",
  fields: [
    { field: "watcher_name", sortable: true, filterable: true },
    { field: "group_key", sortable: true, filterable: true },
    { field: "condition_met", sortable: true, filterable: true, width: 100 },
    { field: "last_fired_at", sortable: true, width: 160 },
    { field: "updated_at", sortable: true, width: 160 },
  ],
  defaultSort: { field: "updated_at", order: "desc" },
  pageSize: 20,
  // No `rowActionRoute`: watcher_state has a composite PK (no single `id`) and
  // no dedicated admin detail route exists, so the list is read-only.
};
