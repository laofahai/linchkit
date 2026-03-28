import { describe, expect, test } from 'bun:test';
import { createAttentionBudget } from '../attention-budget';
import { createUsageImportanceGraph } from '../usage-graph';

describe('AttentionBudget', () => {
  test('rank returns scored candidates sorted by score descending', () => {
    const budget = createAttentionBudget();
    const results = budget.rank([
      { item: 'low', confidence: 0.5, impact: 0.1 },
      { item: 'high', confidence: 1.0, impact: 1.0 },
      { item: 'mid', confidence: 0.7, impact: 0.5 },
    ]);
    expect(results[0].item).toBe('high');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test('respects maxInsightsPerCycle', () => {
    const budget = createAttentionBudget({ maxInsightsPerCycle: 2 });
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      item: `item${i}`,
      confidence: 0.5,
      impact: 0.5,
    }));
    expect(budget.rank(candidates)).toHaveLength(2);
  });

  test('recordIgnore reduces type weight', () => {
    const budget = createAttentionBudget({ ignoreDecay: 0.5 });
    const before = budget.rank([{ item: 'x', confidence: 1, impact: 1, type: 'alert' }]);
    budget.recordIgnore('alert');
    const after = budget.rank([{ item: 'x', confidence: 1, impact: 1, type: 'alert' }]);
    expect(after[0].score).toBeLessThan(before[0].score);
  });

  test('recordEndorse increases type weight', () => {
    const budget = createAttentionBudget({ endorseBoost: 2.0 });
    const before = budget.rank([{ item: 'x', confidence: 1, impact: 1, type: 'report' }]);
    budget.recordEndorse('report');
    const after = budget.rank([{ item: 'x', confidence: 1, impact: 1, type: 'report' }]);
    expect(after[0].score).toBeGreaterThan(before[0].score);
  });

  test('uses usageGraph importance when schema provided', () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage('schema', 'Order');
    graph.recordUsage('schema', 'Order');
    graph.recordUsage('schema', 'Product'); // importance = 0.5
    const budget = createAttentionBudget(undefined, graph);

    const results = budget.rank([
      { item: 'order', confidence: 1, impact: 1, schema: 'Order' },
      { item: 'product', confidence: 1, impact: 1, schema: 'Product' },
    ]);
    expect(results[0].item).toBe('order');
    expect(results[0].breakdown.importance).toBe(1);
    expect(results[1].breakdown.importance).toBe(0.5);
  });
});
