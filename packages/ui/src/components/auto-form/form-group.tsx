/**
 * FormGroup — Group container for form fields.
 *
 * Default 2-column grid layout. No outer border/card, just a grid.
 * Optional title displayed as a subtle section header.
 */

import type { FormGroupNode, FormLayoutNode } from "@linchkit/core";
import { cn } from "../../lib/utils";

interface FormGroupProps {
  node: FormGroupNode;
  depth?: number;
  renderNode: (node: FormLayoutNode, depth: number) => React.ReactNode;
}

export function FormGroup({ node, depth = 0, renderNode }: FormGroupProps) {
  const columns = node.columns ?? 2;

  return (
    <div className={cn(node.className)}>
      {node.title && (
        <div className="col-span-full py-3 border-b border-border/50">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {node.title}
          </h3>
        </div>
      )}
      <div
        className={cn(
          "grid gap-x-8",
          // Mobile: single column
          "max-md:grid-cols-1",
        )}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {node.children.map((child, i) => (
          <div key={getGroupChildKey(child, i)}>
            {renderNode(child, depth + 1)}
          </div>
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
