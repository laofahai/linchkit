import type { UsageImportanceGraph, UsageNode, UsageNodeKind } from '../types/life-system';

function nodeKey(kind: UsageNodeKind, schema: string, name?: string): string {
  return `${kind}:${schema}:${name ?? ''}`;
}

export function createUsageImportanceGraph(): UsageImportanceGraph {
  const nodes = new Map<string, UsageNode>();

  function recomputeImportance(): void {
    // Group by kind to normalize within kind categories
    const maxByKind = new Map<UsageNodeKind, number>();
    for (const node of nodes.values()) {
      const current = maxByKind.get(node.kind) ?? 0;
      if (node.usageCount > current) maxByKind.set(node.kind, node.usageCount);
    }
    for (const node of nodes.values()) {
      const max = maxByKind.get(node.kind) ?? 1;
      node.importance = max > 0 ? node.usageCount / max : 0;
    }
  }

  return {
    recordUsage(kind: UsageNodeKind, schema: string, name?: string): void {
      const key = nodeKey(kind, schema, name);
      const existing = nodes.get(key);
      if (existing) {
        existing.usageCount++;
        existing.lastAccessed = new Date();
      } else {
        nodes.set(key, {
          kind,
          schema,
          name,
          importance: 1,
          usageCount: 1,
          lastAccessed: new Date(),
        });
      }
      recomputeImportance();
    },

    getImportance(kind: UsageNodeKind, schema: string, name?: string): number {
      return nodes.get(nodeKey(kind, schema, name))?.importance ?? 0;
    },

    topN(n: number, kind?: UsageNodeKind): UsageNode[] {
      let all = Array.from(nodes.values());
      if (kind !== undefined) all = all.filter(node => node.kind === kind);
      return all.sort((a, b) => b.importance - a.importance).slice(0, n);
    },

    nodesFor(schema: string): UsageNode[] {
      return Array.from(nodes.values()).filter(node => node.schema === schema);
    },

    toArray(): UsageNode[] {
      return Array.from(nodes.values());
    },
  };
}
