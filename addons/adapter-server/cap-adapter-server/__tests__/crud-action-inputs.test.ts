import { describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
import { generateCrudActions } from "../src/graphql/build-crud-actions";

const departmentSchema: EntityDefinition = {
  name: "department",
  label: "t:entities.department._label",
  fields: {
    name: { type: "string", required: true, label: "t:entities.department.fields.name" },
    code: { type: "string", required: true, label: "t:entities.department.fields.code" },
    budget_limit: { type: "number", label: "t:entities.department.fields.budget_limit" },
    display_name: {
      type: "computed",
      label: "Display Name",
      compute: (record) => record.name,
    },
    deleted_at: { type: "datetime", label: "Deleted At" },
    spent_total: {
      type: "number",
      label: "Spent Total",
      derived: { strategy: "store", expression: "sum(items.amount)" },
    } as EntityDefinition["fields"][string],
  },
};

describe("generateCrudActions input schemas", () => {
  const actions = generateCrudActions(departmentSchema);
  const byName = Object.fromEntries(actions.map((action) => [action.name, action]));

  test("create action exposes entity fields except computed/system/derived fields", () => {
    const action = byName.create_department;
    expect(action).toBeDefined();
    expect(action.input?.name?.required).toBe(true);
    expect(action.input?.code?.required).toBe(true);
    expect(action.input?.budget_limit?.type).toBe("number");
    expect(action.input?.display_name).toBeUndefined();
    expect(action.input?.id).toBeUndefined();
    // Soft-delete is server-managed and never client-settable.
    expect(action.input?.deleted_at).toBeUndefined();
    // Derived store-strategy fields are computed, not user-settable.
    expect(action.input?.spent_total).toBeUndefined();
  });

  test("update action requires id and makes editable fields optional", () => {
    const action = byName.update_department;
    expect(action).toBeDefined();
    expect(action.input?.id?.required).toBe(true);
    expect(action.input?.name?.required).toBe(false);
    expect(action.input?.code?.required).toBe(false);
    expect(action.input?.display_name).toBeUndefined();
    expect(action.input?.deleted_at).toBeUndefined();
    expect(action.input?.spent_total).toBeUndefined();
  });

  test("delete and restore actions require an id", () => {
    const deleteAction = byName.delete_department;
    const restoreAction = byName.restore_department;

    expect(deleteAction?.input?.id?.required).toBe(true);
    expect(deleteAction?.input?.id?.type).toBe("string");
    expect(restoreAction?.input?.id?.required).toBe(true);
    expect(restoreAction?.input?.id?.type).toBe("string");
  });
});
