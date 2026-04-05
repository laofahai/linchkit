/**
 * Cascading Impact Analysis — spec 24 §3
 *
 * BFS traversal of the semantic relation graph to find direct and indirect
 * effects of changes to an entity or capability.
 */

import type { SemanticRelation } from "../types/semantic-relation";

// ── Types ───────────────────────────────────────────────

export interface ImpactNode {
  /** Entity or capability name */
  entity: string;
  /** Capability that owns this entity (if known) */
  capability?: string;
  /** 0 = direct neighbour, 1+ = indirect via chain */
  depth: number;
  /** Chain of entity/capability names from source to this node */
  path: string[];
  /** Relation types along the path */
  relationTypes: string[];
}

export interface ImpactAnalysisResult {
  /** Starting entity or capability */
  source: string;
  /** Nodes at depth 0 (directly connected) */
  directImpacts: ImpactNode[];
  /** Nodes at depth > 0 (indirectly reachable) */
  indirectImpacts: ImpactNode[];
  /** Maximum depth reached */
  maxDepth: number;
  /** Total unique affected nodes */
  totalAffected: number;
}

export interface ImpactAnalysisOptions {
  /** Maximum traversal depth (default 3) */
  maxDepth?: number;
}

// ── Helpers ─────────────────────────────────────────────

/** Get a stable node key from a relation endpoint */
function endpointKey(endpoint: { capability?: string; entity?: string }): string | undefined {
  return endpoint.entity ?? endpoint.capability;
}

// ── Main analysis function ──────────────────────────────

/**
 * Walk the semantic relation graph from `source` using BFS.
 * Returns all directly and indirectly affected nodes.
 */
export function analyzeImpact(
  source: string,
  relations: SemanticRelation[],
  options?: ImpactAnalysisOptions,
): ImpactAnalysisResult {
  const maxDepth = options?.maxDepth ?? 3;

  // Build adjacency list (both from→to and to→from endpoints)
  const adjacency = new Map<string, { target: string; capability?: string; relationType: string }[]>();

  for (const rel of relations) {
    const fromKey = endpointKey(rel.from);
    const toKey = endpointKey(rel.to);
    if (!fromKey || !toKey) continue;

    // Forward edge: from → to
    if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
    adjacency.get(fromKey)!.push({
      target: toKey,
      capability: rel.to.capability,
      relationType: rel.type,
    });

    // Reverse edge: to → from (impact propagates both directions)
    if (!adjacency.has(toKey)) adjacency.set(toKey, []);
    adjacency.get(toKey)!.push({
      target: fromKey,
      capability: rel.from.capability,
      relationType: rel.type,
    });
  }

  const visited = new Set<string>();
  visited.add(source);

  const directImpacts: ImpactNode[] = [];
  const indirectImpacts: ImpactNode[] = [];

  // BFS queue: [nodeKey, depth, path, relationTypes]
  const queue: [string, number, string[], string[]][] = [];

  // Seed from direct neighbours
  const neighbours = adjacency.get(source) ?? [];
  for (const n of neighbours) {
    if (!visited.has(n.target)) {
      queue.push([n.target, 0, [source, n.target], [n.relationType]]);
    }
  }

  while (queue.length > 0) {
    const [nodeKey, depth, path, relTypes] = queue.shift()!;

    if (visited.has(nodeKey)) continue;
    visited.add(nodeKey);

    const node: ImpactNode = {
      entity: nodeKey,
      capability: findCapabilityForNode(nodeKey, relations),
      depth,
      path,
      relationTypes: relTypes,
    };

    if (depth === 0) {
      directImpacts.push(node);
    } else {
      indirectImpacts.push(node);
    }

    // Continue BFS if within depth limit
    if (depth < maxDepth) {
      const nextNeighbours = adjacency.get(nodeKey) ?? [];
      for (const n of nextNeighbours) {
        if (!visited.has(n.target)) {
          queue.push([n.target, depth + 1, [...path, n.target], [...relTypes, n.relationType]]);
        }
      }
    }
  }

  const allImpacts = [...directImpacts, ...indirectImpacts];
  const actualMaxDepth = allImpacts.length > 0 ? Math.max(...allImpacts.map((n) => n.depth)) : 0;

  return {
    source,
    directImpacts,
    indirectImpacts,
    maxDepth: actualMaxDepth,
    totalAffected: allImpacts.length,
  };
}

// ── Internal helpers ────────────────────────────────────

/** Best-effort: find the capability name associated with a node key */
function findCapabilityForNode(nodeKey: string, relations: SemanticRelation[]): string | undefined {
  for (const rel of relations) {
    if (rel.from.entity === nodeKey && rel.from.capability) return rel.from.capability;
    if (rel.to.entity === nodeKey && rel.to.capability) return rel.to.capability;
  }
  return undefined;
}
