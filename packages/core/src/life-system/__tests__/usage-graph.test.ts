import { describe, expect, test } from "bun:test";
import { createUsageImportanceGraph } from "../usage-graph";

describe("UsageImportanceGraph", () => {
  test("recordUsage increments count and getImportance returns 1 for single node", () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage("entity", "Order");
    expect(graph.getImportance("entity", "Order")).toBe(1);
  });

  test("importance is normalized relative to max in same kind", () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage("entity", "Order");
    graph.recordUsage("entity", "Order");
    graph.recordUsage("entity", "Product");
    // Order has 2 usages (max), Product has 1
    expect(graph.getImportance("entity", "Order")).toBe(1);
    expect(graph.getImportance("entity", "Product")).toBe(0.5);
  });

  test("topN returns top nodes sorted by importance descending", () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage("entity", "A");
    graph.recordUsage("entity", "A");
    graph.recordUsage("entity", "A");
    graph.recordUsage("entity", "B");
    graph.recordUsage("entity", "B");
    graph.recordUsage("entity", "C");
    const top2 = graph.topN(2);
    // biome-ignore lint/style/noNonNullAssertion: test assertion - length verified above
    expect(top2[0]!.entity).toBe("A");
    // biome-ignore lint/style/noNonNullAssertion: test assertion - length verified above
    expect(top2[1]!.entity).toBe("B");
  });

  test("topN filters by kind", () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage("entity", "Order");
    graph.recordUsage("action", "Order", "create");
    const schemaOnly = graph.topN(10, "entity");
    expect(schemaOnly.every((n) => n.kind === "entity")).toBe(true);
  });

  test("nodesFor returns all nodes for a schema", () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage("entity", "Order");
    graph.recordUsage("action", "Order", "create");
    graph.recordUsage("field", "Order", "status");
    graph.recordUsage("entity", "Product");
    const nodes = graph.nodesFor("Order");
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n) => n.entity === "Order")).toBe(true);
  });

  test("getImportance returns 0 for unknown node", () => {
    const graph = createUsageImportanceGraph();
    expect(graph.getImportance("entity", "Unknown")).toBe(0);
  });

  test("toArray returns all nodes", () => {
    const graph = createUsageImportanceGraph();
    graph.recordUsage("entity", "A");
    graph.recordUsage("action", "A", "run");
    expect(graph.toArray()).toHaveLength(2);
  });
});
