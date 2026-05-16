/**
 * Tests for the `formLayout()` chain builder — Phase 2 of issue #142.
 *
 * Critical invariants:
 *   1. Chain output deep-equals the helper composition for equivalent input.
 *   2. `.build()` is idempotent (no mutation, no shared references).
 *   3. Nesting works end-to-end: notebook > page > group > row > field.
 *   4. Output is JSON-serializable (no closures, no class instances).
 */

import { describe, expect, it } from "bun:test";
// Import via the public barrel — catches export regressions too.
import { field, formLayout, group, notebook, page, row, separator } from "../src";
import type { FormLayout, FormLayoutNode } from "../src/types/view";

describe("formLayout() chain builder", () => {
  it("produces the same FormLayout as the equivalent helper composition", () => {
    const chain = formLayout()
      .row(field("title"), field("department"))
      .group(field("priority"), field("requester"))
      .notebook(page("Items", field("items")))
      .build();

    const helpers: FormLayout = {
      nodes: [
        row(field("title"), field("department")),
        group(field("priority"), field("requester")),
        notebook(page("Items", field("items"))),
      ],
    };

    expect(chain).toEqual(helpers);
  });

  it("matches the exact shape from the issue body example", () => {
    // formLayout().row(field('a'), field('b')).notebook(...).build()
    const chain = formLayout()
      .row(field("a"), field("b"))
      .notebook(page("Tab", field("c")))
      .build();

    expect(chain).toEqual({
      nodes: [
        {
          type: "group",
          columns: 2,
          children: [
            { type: "field", field: "a" },
            { type: "field", field: "b" },
          ],
        },
        {
          type: "notebook",
          children: [{ type: "page", title: "Tab", children: [{ type: "field", field: "c" }] }],
        },
      ],
    });
  });

  describe("top-level append methods", () => {
    it(".field(name) appends a bare field node", () => {
      const out = formLayout().field("title").build();
      expect(out.nodes).toEqual([{ type: "field", field: "title" }]);
    });

    it(".field(name, opts) forwards options to the helper", () => {
      const out = formLayout().field("title", { label: "T", readonly: true }).build();
      expect(out.nodes).toEqual([{ type: "field", field: "title", label: "T", readonly: true }]);
    });

    it(".row() with no children collapses to a 1-column group", () => {
      const out = formLayout().row().build();
      expect(out.nodes).toEqual([{ type: "group", columns: 1, children: [] }]);
    });

    it(".row() sets columns to child count", () => {
      const out = formLayout().row(field("a"), field("b"), field("c")).build();
      expect(out.nodes).toEqual([
        {
          type: "group",
          columns: 3,
          children: [
            { type: "field", field: "a" },
            { type: "field", field: "b" },
            { type: "field", field: "c" },
          ],
        },
      ]);
    });

    it(".group() with no children produces an empty group", () => {
      const out = formLayout().group().build();
      expect(out.nodes).toEqual([{ type: "group", children: [] }]);
    });

    it(".group() with a single field accepts the same shape as helper", () => {
      const out = formLayout().group(field("only")).build();
      expect(out.nodes).toEqual([{ type: "group", children: [{ type: "field", field: "only" }] }]);
    });

    it(".notebook() collects pages", () => {
      const out = formLayout()
        .notebook(page("Tab 1", field("a")), page("Tab 2", field("b")))
        .build();
      expect(out.nodes).toEqual([
        {
          type: "notebook",
          children: [
            { type: "page", title: "Tab 1", children: [{ type: "field", field: "a" }] },
            { type: "page", title: "Tab 2", children: [{ type: "field", field: "b" }] },
          ],
        },
      ]);
    });

    it(".page() at top level appends a page node", () => {
      const out = formLayout().page("Header", field("a")).build();
      expect(out.nodes).toEqual([
        { type: "page", title: "Header", children: [{ type: "field", field: "a" }] },
      ]);
    });

    it("multiple calls append in call order", () => {
      const out = formLayout().field("a").row(field("b"), field("c")).group(field("d")).build();
      expect(out.nodes).toEqual([
        { type: "field", field: "a" },
        {
          type: "group",
          columns: 2,
          children: [
            { type: "field", field: "b" },
            { type: "field", field: "c" },
          ],
        },
        { type: "group", children: [{ type: "field", field: "d" }] },
      ]);
    });
  });

  describe(".append()", () => {
    it("forwards pre-built nodes verbatim (for shapes the chain can't express)", () => {
      // Group with a title — not expressible via .group(...children) directly.
      const titled: FormLayoutNode = {
        type: "group",
        title: "Customer",
        columns: 1,
        children: [{ type: "field", field: "name" }],
      };
      const out = formLayout().append(titled, separator("End")).build();
      expect(out.nodes).toEqual([
        {
          type: "group",
          title: "Customer",
          columns: 1,
          children: [{ type: "field", field: "name" }],
        },
        { type: "separator", label: "End" },
      ]);
    });

    it("deep-clones appended nodes — caller mutation does not leak", () => {
      const live: FormLayoutNode = {
        type: "group",
        title: "Live",
        children: [{ type: "field", field: "x" }],
      };
      const builder = formLayout().append(live);
      const built = builder.build();

      // Mutate the original
      (live as { title?: string }).title = "Mutated";
      (live.children[0] as { field: string }).field = "y";

      expect(built.nodes).toEqual([
        { type: "group", title: "Live", children: [{ type: "field", field: "x" }] },
      ]);
    });
  });

  describe("nesting end-to-end", () => {
    it("notebook > page > group > row > field round-trips", () => {
      const out = formLayout()
        .notebook(page("Main", group(row(field("a"), field("b")), row(field("c"), field("d")))))
        .build();

      expect(out).toEqual({
        nodes: [
          {
            type: "notebook",
            children: [
              {
                type: "page",
                title: "Main",
                children: [
                  {
                    type: "group",
                    children: [
                      {
                        type: "group",
                        columns: 2,
                        children: [
                          { type: "field", field: "a" },
                          { type: "field", field: "b" },
                        ],
                      },
                      {
                        type: "group",
                        columns: 2,
                        children: [
                          { type: "field", field: "c" },
                          { type: "field", field: "d" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    });
  });

  describe(".build() idempotency", () => {
    it("returns deep-equal but distinct objects on repeated calls", () => {
      const builder = formLayout()
        .row(field("a"), field("b"))
        .notebook(page("Tab", field("c")));

      const a = builder.build();
      const b = builder.build();

      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a.nodes).not.toBe(b.nodes);
      expect(a.nodes?.[0]).not.toBe(b.nodes?.[0]);
      // Children arrays inside nodes must also be cloned.
      const groupA = a.nodes?.[0];
      const groupB = b.nodes?.[0];
      if (groupA?.type === "group" && groupB?.type === "group") {
        expect(groupA.children).not.toBe(groupB.children);
        expect(groupA.children[0]).not.toBe(groupB.children[0]);
      }
    });

    it("mutating one build() result does not affect the other", () => {
      const builder = formLayout().row(field("a"));

      const first = builder.build();
      const second = builder.build();

      // Mutate first's row node
      const firstRow = first.nodes?.[0];
      if (firstRow?.type === "group") {
        firstRow.children.push({ type: "field", field: "leaked" });
        firstRow.title = "leaked";
      }

      const secondRow = second.nodes?.[0];
      if (secondRow?.type === "group") {
        expect(secondRow.children).toEqual([{ type: "field", field: "a" }]);
        expect(secondRow.title).toBeUndefined();
      }
    });

    it("subsequent builder calls after build() reflect in the next build()", () => {
      const builder = formLayout().field("a");
      const first = builder.build();
      builder.field("b");
      const second = builder.build();

      expect(first.nodes).toEqual([{ type: "field", field: "a" }]);
      expect(second.nodes).toEqual([
        { type: "field", field: "a" },
        { type: "field", field: "b" },
      ]);
    });

    it("mutating field opts after build() does not leak across builds", () => {
      const condition = { field: "type", operator: "eq" as const, value: "A" };
      const builder = formLayout().field("name", { visibleWhen: condition });
      const a = builder.build();
      const b = builder.build();

      // Mutate the original condition
      condition.value = "B";

      const fieldA = a.nodes?.[0];
      const fieldB = b.nodes?.[0];
      if (fieldA?.type === "field" && fieldB?.type === "field") {
        expect(fieldA.visibleWhen?.value).toBe("A");
        expect(fieldB.visibleWhen?.value).toBe("A");
        expect(fieldA.visibleWhen).not.toBe(fieldB.visibleWhen);
      }
    });
  });

  describe("output shape guarantees", () => {
    it("output is JSON-serializable (no functions, no cycles)", () => {
      const out = formLayout()
        .row(field("a"), field("b"))
        .notebook(page("Tab", field("c")))
        .build();
      const json = JSON.stringify(out);
      expect(JSON.parse(json)).toEqual(out);
    });

    it("empty builder yields { nodes: [] }", () => {
      expect(formLayout().build()).toEqual({ nodes: [] });
    });
  });
});
