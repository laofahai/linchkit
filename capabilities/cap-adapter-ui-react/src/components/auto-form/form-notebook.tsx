/**
 * FormNotebook — Tab container with bottom border indicator (Odoo-style).
 *
 * Active tab has a primary-colored bottom border that overlaps
 * the parent border using -mb-px.
 */

import type { FormLayoutNode, FormNotebookNode } from "@linchkit/core";
import { cn } from "@linchkit/ui-kit/lib/utils";

interface FormNotebookProps {
  node: FormNotebookNode;
  activeTab: number;
  onTabChange: (index: number) => void;
  renderNode: (node: FormLayoutNode, depth: number) => React.ReactNode;
}

export function FormNotebook({ node, activeTab, onTabChange, renderNode }: FormNotebookProps) {
  const currentTab = activeTab;

  return (
    <div className={cn("mt-4", node.className)}>
      {/* Tab headers with bottom border */}
      <div className="flex gap-1 border-b border-border">
        {node.children.map((page, i) => (
          <button
            key={page.title}
            type="button"
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors",
              "text-muted-foreground hover:text-foreground",
              i === currentTab && "text-foreground border-b-2 border-primary -mb-px",
            )}
            onClick={() => onTabChange(i)}
          >
            {page.title}
          </button>
        ))}
      </div>

      {/* Active page content */}
      {node.children[currentTab] && (
        <div className="py-3">
          {node.children[currentTab].children.map((child, i) => (
            <div key={getNodeKey(child, i)}>{renderNode(child, 1)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function getNodeKey(node: FormLayoutNode, index: number): string {
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
