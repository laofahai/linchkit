/**
 * Watcher-state system entity registration tests (Spec 45 §7.1).
 *
 * Asserts that `watcher_state` is registered as a system entity exactly like
 * the other system entities (execution_log, approval, rule, flow,
 * state_machine, proposal): present in the `INTERNAL_SCHEMA_NAMES` whitelist,
 * the `systemSchemas` array, and the `systemViews` array — and that its
 * EntityDefinition + ViewDefinition mirror the `_linchkit.watcher_state` table.
 */

import { describe, expect, test } from "bun:test";
import {
  INTERNAL_SCHEMA_NAMES,
  systemSchemas,
  systemViews,
  watcherStateListView,
  watcherStateSchema,
} from "../src/system-schemas";

describe("watcher_state system entity registration", () => {
  test("watcher_state is in the INTERNAL_SCHEMA_NAMES whitelist", () => {
    expect(INTERNAL_SCHEMA_NAMES.has("watcher_state")).toBe(true);
  });

  test("watcher_state schema is registered in systemSchemas", () => {
    const found = systemSchemas.find((s) => s.name === "watcher_state");
    expect(found).toBeDefined();
    expect(found).toBe(watcherStateSchema);
  });

  test("watcher_state list view is registered in systemViews", () => {
    const found = systemViews.find((v) => v.name === "watcher_state_list");
    expect(found).toBeDefined();
    expect(found).toBe(watcherStateListView);
    expect(found?.entity).toBe("watcher_state");
  });

  test("watcher_state schema mirrors the _linchkit.watcher_state table columns", () => {
    const fieldNames = Object.keys(watcherStateSchema.fields).sort();
    expect(fieldNames).toEqual(
      [
        "condition_met",
        "group_key",
        "last_fired_at",
        "tenant_id",
        "updated_at",
        "watcher_name",
      ].sort(),
    );

    // Field types match the table shape.
    expect(watcherStateSchema.fields.watcher_name?.type).toBe("string");
    expect(watcherStateSchema.fields.group_key?.type).toBe("string");
    expect(watcherStateSchema.fields.last_fired_at?.type).toBe("datetime");
    expect(watcherStateSchema.fields.condition_met?.type).toBe("boolean");
    expect(watcherStateSchema.fields.tenant_id?.type).toBe("string");
    expect(watcherStateSchema.fields.updated_at?.type).toBe("datetime");

    // Composite PK members are required + primary in the UI.
    expect(watcherStateSchema.fields.watcher_name?.required).toBe(true);
    expect(watcherStateSchema.fields.group_key?.required).toBe(true);
    expect(watcherStateSchema.fields.watcher_name?.ui?.importance).toBe("primary");
    expect(watcherStateSchema.fields.group_key?.ui?.importance).toBe("primary");

    // i18n labels follow the `t:entities.watcher_state.*` convention.
    expect(watcherStateSchema.label).toBe("t:entities.watcher_state._label");
    expect(watcherStateSchema.presentation?.titleField).toBe("watcher_name");
  });

  test("watcher_state list view sorts by updated_at desc and has no rowActionRoute", () => {
    expect(watcherStateListView.type).toBe("list");
    expect(watcherStateListView.defaultSort).toEqual({ field: "updated_at", order: "desc" });
    expect(watcherStateListView.pageSize).toBe(20);
    // Composite PK / no admin detail route → no rowActionRoute.
    expect(watcherStateListView.rowActionRoute).toBeUndefined();
  });
});
