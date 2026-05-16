/**
 * formLayout — Chain-style builder for view form layouts.
 *
 * Phase 2 of issue #142. Mirrors the dual-entry pattern established by
 * `permissionGroup()` in cap-permission: provides an IDE-guided chain API
 * that produces the SAME plain `FormLayout` object as the equivalent
 * composition of the standalone helpers (`field`, `row`, `group`,
 * `notebook`, `page`) from `./layout-helpers`.
 *
 * Design notes:
 *   - `.build()` is idempotent: each call returns a fresh deep-clone, the
 *     internal state is never mutated by `build()`, and the returned object
 *     shares no references with the builder or with prior builds.
 *   - Every node appended through chain methods is normalized to the exact
 *     plain shape produced by the helpers — no closures, no class instances,
 *     no symbols — keeping the output JSONB-safe.
 *   - Top-level nodes are collected in order; multiple `.row(...)` /
 *     `.group(...)` / `.field(...)` / `.notebook(...)` / `.page(...)` calls
 *     append in call order.
 *   - Both `.row()` and `.group()` follow the helper semantics exactly:
 *     `.row(a, b)` becomes `{ type: "group", columns: 2, children: [a, b] }`
 *     and `.group(a, b)` becomes `{ type: "group", children: [a, b] }`. For
 *     decorated groups (`title`, `className`, custom `columns`), use the
 *     verbose JSON form via `.append()` — see below.
 *
 * @example
 *   const layout = formLayout()
 *     .row(field("title"), field("department"))
 *     .group(field("priority"), field("requester"))
 *     .notebook(page("Items", field("items")))
 *     .build();
 *
 *   // Same shape as:
 *   //   { nodes: [
 *   //     row(field("title"), field("department")),
 *   //     group(field("priority"), field("requester")),
 *   //     notebook(page("Items", field("items"))),
 *   //   ] }
 */

import type { FormFieldNode, FormLayout, FormLayoutNode, FormPageNode } from "../types/view";
import { type FieldOptions, field, group, notebook, page, row } from "./layout-helpers";

// ── Builder interface ───────────────────────────────────────

export interface FormLayoutBuilder {
  /** Append a bare field node at the top level. */
  field(name: string, opts?: FieldOptions): FormLayoutBuilder;
  /** Append a row (group with `columns = children.length`). */
  row(...children: FormLayoutNode[]): FormLayoutBuilder;
  /** Append a group (default 2-column container). */
  group(...children: FormLayoutNode[]): FormLayoutBuilder;
  /** Append a notebook (tab container) holding the given pages. */
  notebook(...pages: FormPageNode[]): FormLayoutBuilder;
  /** Append a page node (typically used as a notebook child; here for parity). */
  page(title: string, ...children: FormLayoutNode[]): FormLayoutBuilder;
  /**
   * Append one or more pre-built layout nodes verbatim. Useful for shapes the
   * chain methods can't express directly (e.g. groups with `title` /
   * `className`, separators with labels). Each node is deep-cloned on
   * `.build()`, so callers may freely reuse the same node object.
   */
  append(...nodes: FormLayoutNode[]): FormLayoutBuilder;
  /** Materialize the layout. Idempotent — each call returns a fresh clone. */
  build(): FormLayout;
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Start building a form layout.
 *
 * The returned builder accumulates top-level nodes. `.build()` returns
 * `{ nodes: FormLayoutNode[] }` — the canonical shape consumed by
 * `ViewDefinition.layout`.
 */
export function formLayout(): FormLayoutBuilder {
  const nodes: FormLayoutNode[] = [];

  const builder: FormLayoutBuilder = {
    field(name, opts) {
      nodes.push(field(name, opts));
      return builder;
    },

    row(...children) {
      nodes.push(row(...children));
      return builder;
    },

    group(...children) {
      nodes.push(group(...children));
      return builder;
    },

    notebook(...pages) {
      nodes.push(notebook(...pages));
      return builder;
    },

    page(title, ...children) {
      nodes.push(page(title, ...children));
      return builder;
    },

    append(...incoming) {
      for (const node of incoming) {
        nodes.push(node);
      }
      return builder;
    },

    build() {
      return { nodes: nodes.map(cloneNode) };
    },
  };

  return builder;
}

// ── Deep clone (covers the FormLayoutNode union) ────────────

/**
 * Deep-clone a layout node. All node payloads are plain JSON, so
 * `structuredClone` would also work — but we walk the tree by hand to (a)
 * keep the dependency footprint zero and (b) make it explicit which fields
 * each node type carries (so a future field addition forces a compile-time
 * update here).
 */
function cloneNode(node: FormLayoutNode): FormLayoutNode {
  switch (node.type) {
    case "field":
      return cloneFieldNode(node);
    case "group":
      return {
        type: "group",
        ...(node.title !== undefined ? { title: node.title } : {}),
        ...(node.columns !== undefined ? { columns: node.columns } : {}),
        ...(node.className !== undefined ? { className: node.className } : {}),
        children: node.children.map(cloneNode),
      };
    case "notebook":
      return {
        type: "notebook",
        ...(node.className !== undefined ? { className: node.className } : {}),
        children: node.children.map(clonePageNode),
      };
    case "page":
      return clonePageNode(node);
    case "separator":
      return node.label !== undefined
        ? { type: "separator", label: node.label }
        : { type: "separator" };
  }
}

function cloneFieldNode(node: FormFieldNode): FormFieldNode {
  const out: FormFieldNode = { type: "field", field: node.field };
  if (node.label !== undefined) out.label = node.label;
  if (node.readonly !== undefined) out.readonly = node.readonly;
  if (node.colspan !== undefined) out.colspan = node.colspan;
  if (node.widget !== undefined) out.widget = node.widget;
  if (node.nolabel !== undefined) out.nolabel = node.nolabel;
  if (node.className !== undefined) out.className = node.className;
  if (node.visibleWhen !== undefined) {
    // `visibleWhen.value` is `unknown` — structuredClone safely walks it.
    out.visibleWhen = structuredClone(node.visibleWhen);
  }
  return out;
}

function clonePageNode(node: FormPageNode): FormPageNode {
  return {
    type: "page",
    title: node.title,
    ...(node.className !== undefined ? { className: node.className } : {}),
    children: node.children.map(cloneNode),
  };
}
