import { describe, expect, test } from 'bun:test';
import { createAwarenessEngine } from '../awareness-engine';
import type { OntologyRegistry, SchemaDescriptor } from '../../ontology/ontology-registry';
import type { SensorSignal } from '../../types/life-system';

function makeOntology(schemas: Record<string, Partial<SchemaDescriptor>>): OntologyRegistry {
  return {
    describe(name: string) {
      return schemas[name] as SchemaDescriptor | undefined;
    },
    listSchemas() {
      return Object.keys(schemas);
    },
  } as unknown as OntologyRegistry;
}

function makeSignal(schema: string, sensor = 'test'): SensorSignal {
  return {
    sensor,
    source: 'api',
    timestamp: new Date(),
    value: 1,
    baseline: 1,
    deviation: 0,
    confidence: 1,
    context: { schema },
  };
}

describe('AwarenessEngine', () => {
  test('ingestSignal updates usage graph for schema', () => {
    const ontology = makeOntology({ Order: { views: [{ name: 'list' } as never], actions: [] } });
    const engine = createAwarenessEngine({ ontology });
    engine.ingestSignal(makeSignal('Order'));
    expect(engine.usageGraph.getImportance('schema', 'Order')).toBeGreaterThan(0);
  });

  test('structuralCheck detects schema_no_view', () => {
    const ontology = makeOntology({
      Order: { views: [], actions: [] },
      Product: { views: [{ name: 'list' } as never], actions: [] },
    });
    const engine = createAwarenessEngine({ ontology });
    const issues = engine.structuralCheck();
    const noViewIssues = issues.filter(i => i.kind === 'schema_no_view');
    expect(noViewIssues).toHaveLength(1);
    expect(noViewIssues[0].schema).toBe('Order');
  });

  test('structuralCheck detects action_never_called', () => {
    const ontology = makeOntology({
      Order: {
        views: [{ name: 'list' } as never],
        actions: [{ name: 'approve' } as never, { name: 'reject' } as never],
      },
    });
    const engine = createAwarenessEngine({ ontology });
    const issues = engine.structuralCheck();
    const neverCalled = issues.filter(i => i.kind === 'action_never_called');
    expect(neverCalled).toHaveLength(2);
    expect(neverCalled.map(i => i.target)).toContain('approve');
    expect(neverCalled.map(i => i.target)).toContain('reject');
  });

  test('action_never_called not reported after usage recorded', () => {
    const ontology = makeOntology({
      Order: {
        views: [{ name: 'list' } as never],
        actions: [{ name: 'approve' } as never],
      },
    });
    const engine = createAwarenessEngine({ ontology });
    engine.usageGraph.recordUsage('action', 'Order', 'approve');
    const issues = engine.structuralCheck();
    expect(issues.filter(i => i.kind === 'action_never_called')).toHaveLength(0);
  });
});
