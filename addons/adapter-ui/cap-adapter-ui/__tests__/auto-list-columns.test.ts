/**
 * Tests for the auto-list column cell rendering of relation-resolver fields.
 *
 * Relation columns (e.g. `department`) have no entry in `schema.fields`, so
 * the cell renderer falls through to the schemaless path. The row value is an
 * expanded object (`{ id, name }` from `department { id name }`), which used
 * to be rendered via `String(value)` → "[object Object]". It must now resolve
 * the human-readable label exactly like the detail view does, or fall back to
 * an em-dash placeholder.
 *
 * The test setup is logic-only (no DOM): we invoke the ColumnDef `cell`
 * function directly with a minimal CellContext and inspect the ReactNode it
 * returns (plain string for resolved labels, a <span> element for the
 * placeholder).
 */

import { describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core/types";
import type { ColumnDef } from "@tanstack/react-table";
import { buildColumns } from "../src/components/auto-list/columns";

type DataRow = Record<string, unknown>;

/** Minimal schema: `department` is intentionally NOT among the fields. */
const schema = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", label: "Title" },
  },
} as unknown as EntityDefinition;

function buildTestColumns(): ColumnDef<DataRow>[] {
  return buildColumns({
    fields: [{ field: "title" }, { field: "department" }],
    schema,
    rowActions: [],
  });
}

/** Invoke a column's cell renderer with a minimal CellContext stand-in. */
function renderCell(col: ColumnDef<DataRow>, value: unknown, original: DataRow = {}): unknown {
  const cell = col.cell as (ctx: {
    getValue: () => unknown;
    row: { original: DataRow };
  }) => unknown;
  expect(typeof cell).toBe("function");
  return cell({ getValue: () => value, row: { original } });
}

/** Extract the rendered children of a React element-shaped result. */
function elementChildren(result: unknown): unknown {
  return (result as { props: { children?: unknown } }).props.children;
}

describe("buildColumns relation cell rendering", () => {
  const departmentCol = buildTestColumns()[1];
  if (!departmentCol) throw new Error("department column missing");

  test("resolves an expanded relation object to its display name", () => {
    const result = renderCell(departmentCol, { id: "d1", name: "Engineering" }, { id: "r1" });
    expect(result).toBe("Engineering");
  });

  test("resolves an array relation to a joined label list", () => {
    const result = renderCell(departmentCol, [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
    expect(result).toBe("Alpha, Beta");
  });

  test("resolves a translatable display field instead of stringifying it", () => {
    const result = renderCell(departmentCol, {
      id: "d1",
      name: { en: "Engineering", "zh-CN": "工程部" },
    });
    // Locale comes from i18next.language (uninitialized in tests → en/first fallback).
    expect(result).toBe("Engineering");
  });

  test("renders a placeholder for null / undefined values", () => {
    for (const value of [null, undefined, ""]) {
      const result = renderCell(departmentCol, value);
      expect(elementChildren(result)).toBe("—");
    }
  });

  test("renders a placeholder (not String(object)) for unresolvable objects", () => {
    const result = renderCell(departmentCol, { nested: { deep: 1 } });
    expect(elementChildren(result)).toBe("—");
  });

  test('never renders the literal "[object Object]"', () => {
    const inputs: unknown[] = [
      { id: "d1", name: "Engineering" },
      { id: "d1" },
      { nested: { deep: 1 } },
      [{ id: "a" }, {}],
      {},
    ];
    for (const value of inputs) {
      const result = renderCell(departmentCol, value);
      if (typeof result === "string") {
        expect(result).not.toContain("[object Object]");
      }
    }
  });

  test("still stringifies scalar values for schemaless columns", () => {
    expect(renderCell(departmentCol, "Finance")).toBe("Finance");
    expect(renderCell(departmentCol, 42)).toBe("42");
  });
});
