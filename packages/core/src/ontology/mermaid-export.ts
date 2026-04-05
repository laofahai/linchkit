/**
 * Mermaid Export — spec 24 §4
 *
 * Generate Mermaid diagram syntax from semantic relation graphs.
 */

import type { SemanticRelation, SemanticRelationType } from "../types/semantic-relation";

// ── Types ───────────────────────────────────────────────

export interface MermaidExportOptions {
  /** Only show relations within 2 hops of this entity/capability */
  focus?: string;
  /** Maximum number of nodes to include (default 30) */
  maxNodes?: number;
}

// ── Arrow styles per relation type ──────────────────────

/** Structural relations use solid arrows, semantic use dashed */
const ARROW_STYLE: Record<SemanticRelationType, string> = {
  depends_on: "-->",
  contains: "-->",
  references: "-->",
  affects: "-.->",
  triggers: "-.->",
  orchestrates: "-.->",
  reads_from: "-.->",
  bridges: "-.->",
  conflicts_with: "<-.->",
  replaces: "-.->",
  derived_from: "-.->",
};

// ── Helpers ─────────────────────────────────────────────

function endpointKey(endpoint: { capability?: string; entity?: string }): string {
  return endpoint.entity ?? endpoint.capability ?? "unknown";
}

/** Sanitize a node ID for Mermaid (remove special characters) */
function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Collect nodes within `maxHops` of `focus` in the relation list.
 */
function collectFocusedNodes(
  focus: string,
  relations: SemanticRelation[],
  maxHops: number,
): Set<string> {
  const nodes = new Set<string>();
  nodes.add(focus);

  // Build adjacency
  const adjacency = new Map<string, Set<string>>();
  for (const rel of relations) {
    const from = endpointKey(rel.from);
    const to = endpointKey(rel.to);
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    if (!adjacency.has(to)) adjacency.set(to, new Set());
    adjacency.get(from)!.add(to);
    adjacency.get(to)!.add(from);
  }

  // BFS
  let frontier = [focus];
  for (let hop = 0; hop < maxHops; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (!nodes.has(neighbour)) {
          nodes.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return nodes;
}

// ── Main export function ────────────────────────────────

/**
 * Generate Mermaid `graph LR` syntax from semantic relations.
 */
export function generateSemanticMermaid(
  relations: SemanticRelation[],
  options?: MermaidExportOptions,
): string {
  const maxNodes = options?.maxNodes ?? 30;
  const focus = options?.focus;

  // Filter relations if focus is set
  let filtered = relations;
  if (focus) {
    const allowedNodes = collectFocusedNodes(focus, relations, 2);
    filtered = relations.filter((rel) => {
      const from = endpointKey(rel.from);
      const to = endpointKey(rel.to);
      return allowedNodes.has(from) && allowedNodes.has(to);
    });
  }

  // Collect unique nodes, respecting maxNodes limit
  const nodeSet = new Set<string>();
  const edges: string[] = [];

  for (const rel of filtered) {
    const from = endpointKey(rel.from);
    const to = endpointKey(rel.to);

    // Skip if adding would exceed node limit
    const newNodes = (nodeSet.has(from) ? 0 : 1) + (nodeSet.has(to) ? 0 : 1);
    if (nodeSet.size + newNodes > maxNodes) continue;

    nodeSet.add(from);
    nodeSet.add(to);

    const arrow = ARROW_STYLE[rel.type] ?? "-->";
    const fromId = sanitizeId(from);
    const toId = sanitizeId(to);
    edges.push(`  ${fromId}[${from}] ${arrow}|${rel.type}| ${toId}[${to}]`);
  }

  const lines = ["graph LR", ...edges];
  return lines.join("\n");
}
