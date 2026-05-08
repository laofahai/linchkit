/**
 * Tests for `@linchkit/core` view layout helpers.
 *
 * The helpers must be pure syntactic sugar — same JSON shape as the
 * verbose `FormLayoutNode` syntax, no behavior, no metadata.
 */

import { describe, expect, it } from "bun:test";
// Import via the public barrel so this test catches barrel-export regressions.
import { field, group, notebook, page, row, separator } from "../src";
import type { FormLayoutNode } from "../src/types/view";

describe("view layout helpers", () => {
  it("field(name) returns a bare field node", () => {
    expect(field("title")).toEqual({ type: "field", field: "title" });
  });

  it("field(name, opts) spreads opts over the base", () => {
    expect(field("title", { label: "Title", readonly: true, colspan: 2 })).toEqual({
      type: "field",
      field: "title",
      label: "Title",
      readonly: true,
      colspan: 2,
    });
  });

  it("field(name, opts) ignores user-supplied type/field in opts", () => {
    // Negative-control input — caller force-casts forbidden keys to slip them
    // past the FieldOptions type. The helper's literal values must still win.
    const opts = { type: "field", field: "wrong", label: "Real" } as unknown as Parameters<
      typeof field
    >[1];
    const result = field("title", opts);
    expect(result.type).toBe("field");
    expect(result.field).toBe("title");
    expect(result.label).toBe("Real");
  });

  it("group(child1, child2) wraps children in a group node", () => {
    const a = field("a");
    const b = field("b");
    expect(group(a, b)).toEqual({ type: "group", children: [a, b] });
  });

  it("row(child1, child2) sets columns to child count", () => {
    const a = field("a");
    const b = field("b");
    expect(row(a, b)).toEqual({ type: "group", columns: 2, children: [a, b] });
  });

  it("row() with no children collapses to a 1-column group", () => {
    expect(row()).toEqual({ type: "group", columns: 1, children: [] });
  });

  it("notebook(page1, page2) wraps pages as children", () => {
    const p1 = page("Tab 1", field("a"));
    const p2 = page("Tab 2", field("b"));
    expect(notebook(p1, p2)).toEqual({ type: "notebook", children: [p1, p2] });
  });

  it("page(title, child1, child2) wraps children with the tab title", () => {
    const a = field("a");
    const b = field("b");
    expect(page("Items", a, b)).toEqual({
      type: "page",
      title: "Items",
      children: [a, b],
    });
  });

  it("separator() returns a bare separator node", () => {
    expect(separator()).toEqual({ type: "separator" });
  });

  it("output is JSON-serializable (deterministic, no functions, no cycles)", () => {
    const tree = row(group(field("a"), field("b")));
    const json = JSON.stringify(tree);
    // Re-parsing must yield a structurally identical value.
    expect(JSON.parse(json)).toEqual(tree);
    // No functions or class instances slipped in.
    expect(json.includes("function")).toBe(false);
  });

  it("round-trips with the verbose syntax (helpers === sugar)", () => {
    // The "worst example" shape, built two ways.
    const verbose: { nodes: FormLayoutNode[] } = {
      nodes: [
        {
          type: "group",
          children: [
            {
              type: "group",
              children: [
                { type: "field", field: "title" },
                { type: "field", field: "department" },
              ],
            },
            {
              type: "group",
              children: [
                { type: "field", field: "priority" },
                { type: "field", field: "requester" },
              ],
            },
          ],
        },
        { type: "separator" },
        {
          type: "group",
          columns: 1,
          children: [{ type: "field", field: "description", nolabel: true }],
        },
        {
          type: "notebook",
          children: [
            {
              type: "page",
              title: "Items",
              children: [{ type: "field", field: "items" }],
            },
          ],
        },
      ],
    };

    // Same shape, expressed entirely via helpers — no raw fallback object.
    // `row(field(...))` covers the `columns: 1` single-child group case.
    const sugared: { nodes: FormLayoutNode[] } = {
      nodes: [
        group(
          group(field("title"), field("department")),
          group(field("priority"), field("requester")),
        ),
        separator(),
        row(field("description", { nolabel: true })),
        notebook(page("Items", field("items"))),
      ],
    };

    expect(sugared).toEqual(verbose);
  });
});
