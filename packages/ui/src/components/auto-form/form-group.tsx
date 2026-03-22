/**
 * FormGroup — Group container for form fields.
 *
 * Top-level groups use a multi-column layout (default 2).
 * Inner groups use a label-value grid (auto 1fr) so all labels
 * within the same group auto-align to the widest one.
 */

import type { FormGroupNode, FormLayoutNode } from "@linchkit/core";
import { cn } from "@linchkit/ui-kit/lib/utils";

interface FormGroupProps {
  node: FormGroupNode;
  depth?: number;
  renderNode: (node: FormLayoutNode, depth: number) => React.ReactNode;
}

export function FormGroup({ node, depth = 0, renderNode }: FormGroupProps) {
  const columns = node.columns ?? (depth === 0 ? 2 : 1);

  if (depth > 0) {
    // Inner group: label-value grid where all labels auto-align
    return (
      <div className={cn(node.className)}>
        {node.title && (
          <div className="py-3 border-b border-border/50">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {node.title}
            </h3>
          </div>
        )}
        <div className="grid gap-y-0" style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}>
          {node.children.map((child, i) => (
            <div key={getGroupChildKey(child, i)} className="contents">
              {renderNode(child, depth + 1)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Top-level group: equal columns, each containing an inner group
  return (
    <div className={cn(node.className)}>
      {node.title && (
        <div className="py-3 border-b border-border/50">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {node.title}
          </h3>
        </div>
      )}
      <div
        className={cn("grid gap-x-8", "max-md:grid-cols-1")}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {node.children.map((child, i) => (
          <div key={getGroupChildKey(child, i)}>{renderNode(child, depth + 1)}</div>
        ))}
      </div>
    </div>
  );
}

function getGroupChildKey(node: FormLayoutNode, index: number): string {
  switch (node.type) {
    case "field":
      return `field-${node.field}`;
    case "group":
      return `group-${node.title ?? index}`;
    case "notebook":
      return `notebook-${index}`;
    case "page":
      return `page-${node.title}`;
    case "separator":
      return `sep-${node.label ?? index}`;
    default:
      return `node-${index}`;
  }
}
