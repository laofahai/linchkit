import { describe, expect, test } from 'bun:test';
import { createUsageImportanceGraph } from '../usage-graph';

describe('UsageImportanceGraph', () => {
  test('recordUsage increments count and getImportance returns 1 for single node', () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage('schema', 'Order');
    expect(graph.getImportance('schema', 'Order')).toBe(1);
  });

  test('importance is normalized relative to max in same kind', () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage('schema', 'Order');
    graph.recordUsage('schema', 'Order');
    graph.recordUsage('schema', 'Product');
    // Order has 2 usages (max), Product has 1
    expect(graph.getImportance('schema', 'Order')).toBe(1);
    expect(graph.getImportance('schema', 'Product')).toBe(0.5);
  });

  test('topN returns top nodes sorted by importance descending', () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage('schema', 'A');
    graph.recordUsage('schema', 'A');
    graph.recordUsage('schema', 'A');
    graph.recordUsage('schema', 'B');
    graph.recordUsage('schema', 'B');
    graph.recordUsage('schema', 'C');
    const top2 = graph.topN(2);
    expect(top2[0].schema).toBe('A');
    expect(top2[1].schema).toBe('B');
  });

  test('topN filters by kind', () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage('schema', 'Order');
    graph.recordUsage('action', 'Order', 'create');
    const schemaOnly = graph.topN(10, 'schema');
    expect(schemaOnly.every(n => n.kind === 'schema')).toBe(true);
  });

  test('nodesFor returns all nodes for a schema', () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage('schema', 'Order');
    graph.recordUsage('action', 'Order', 'create');
    graph.recordUsage('field', 'Order', 'status');
    graph.recordUsage('schema', 'Product');
    const nodes = graph.nodesFor('Order');
    expect(nodes).toHaveLength(3);
    expect(nodes.every(n => n.schema === 'Order')).toBe(true);
  });

  test('getImportance returns 0 for unknown node', () => {
    const graph = createUsageImportanceGraph();
    expect(graph.getImportance('schema', 'Unknown')).toBe(0);
  });

  test('toArray returns all nodes', () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage('schema', 'A');
    graph.recordUsage('action', 'A', 'run');
    expect(graph.toArray()).toHaveLength(2);
  });
});
