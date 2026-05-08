/**
 * Form layout helper functions.
 *
 * Pure syntactic sugar over the verbose `FormLayoutNode` JSON shape — each
 * helper returns the same plain object the verbose syntax produces, so they
 * are JSON-serializable and behave identically at render time.
 *
 * The helpers are optional. The verbose syntax keeps working unchanged. They
 * cover the common-case shape per issue #144 — for the optional decorative
 * fields (`title`, `className` on group/notebook/page, `label` on separator),
 * use the verbose JSON object directly.
 *
 * @example
 *   layout: {
 *     nodes: [
 *       row(
 *         group(field("title"), field("department")),
 *         group(field("priority"), field("requester")),
 *       ),
 *       separator(),
 *       field("description"),
 *       notebook(page("Items", field("items"))),
 *     ],
 *   }
 */

import type {
  FormFieldNode,
  FormGroupNode,
  FormLayoutNode,
  FormNotebookNode,
  FormPageNode,
  FormSeparatorNode,
} from "../types/view";

/** Optional fields accepted by `field(name, opts?)`. `type` and `field` are owned by the helper. */
export type FieldOptions = Omit<FormFieldNode, "type" | "field">;

/**
 * Build a field node: `{ type: "field", field: name, ...opts }`.
 *
 * `opts.type` and `opts.field` are intentionally not part of `FieldOptions`;
 * if a caller force-casts them in, the helper's literal values still win
 * because the spread happens before the literal assignments.
 */
export function field(name: string, opts?: FieldOptions): FormFieldNode {
  return { ...opts, type: "field", field: name };
}

/** Build a group node containing the given children. */
export function group(...children: FormLayoutNode[]): FormGroupNode {
  return { type: "group", children };
}

/**
 * Build a horizontal-row group: a group whose `columns` equals the child
 * count, so the renderer lays the children out side-by-side. A row with no
 * children collapses to a 1-column group (renderer's safe default).
 */
export function row(...children: FormLayoutNode[]): FormGroupNode {
  return {
    type: "group",
    columns: children.length > 0 ? children.length : 1,
    children,
  };
}

/** Build a notebook (tab container) from the given pages. */
export function notebook(...pages: FormPageNode[]): FormNotebookNode {
  return { type: "notebook", children: pages };
}

/** Build a notebook page with a tab title and body children. */
export function page(title: string, ...children: FormLayoutNode[]): FormPageNode {
  return { type: "page", title, children };
}

/** Build a visual separator. The optional label renders as a caption beside the line. */
export function separator(label?: string): FormSeparatorNode {
  return label !== undefined ? { type: "separator", label } : { type: "separator" };
}
