import { describe, expect, it } from "bun:test";
import { analyzeImpact } from "../src/ontology/impact-analysis";
import type { SemanticRelation } from "../src/types/semantic-relation";

// ── Fixtures ─────────────────────────────────────────────

/** Simple linear chain: A → B → C → D */
function linearChain(): SemanticRelation[] {
  return [
    {
      id: "a->refs->b",
      type: "references",
      from: { capability: "cap_a", entity: "entity_a" },
      to: { capability: "cap_b", entity: "entity_b" },
      source: "schema_ref",
    },
    {
      id: "b->triggers->c",
      type: "triggers",
      from: { capability: "cap_b", entity: "entity_b" },
      to: { capability: "cap_c", entity: "entity_c" },
      source: "event_handler",
    },
    {
      id: "c->affects->d",
      type: "affects",
      from: { capability: "cap_c", entity: "entity_c" },
      to: { capability: "cap_d", entity: "entity_d" },
      source: "bridge_definition",
    },
  ];
}

/** Cycle: A → B → C → A */
function cyclicGraph(): SemanticRelation[] {
  return [
    {
      id: "a->refs->b",
      type: "references",
      from: { entity: "entity_a" },
      to: { entity: "entity_b" },
      source: "schema_ref",
    },
    {
      id: "b->triggers->c",
      type: "triggers",
      from: { entity: "entity_b" },
      to: { entity: "entity_c" },
      source: "event_handler",
    },
    {
      id: "c->affects->a",
      type: "affects",
      from: { entity: "entity_c" },
      to: { entity: "entity_a" },
      source: "bridge_definition",
    },
  ];
}

/** Branching: A → B, A → C, B → D, C → D */
function branchingGraph(): SemanticRelation[] {
  return [
    {
      id: "a->refs->b",
      type: "references",
      from: { entity: "entity_a" },
      to: { entity: "entity_b" },
      source: "schema_ref",
    },
    {
      id: "a->contains->c",
      type: "contains",
      from: { entity: "entity_a" },
      to: { entity: "entity_c" },
      source: "schema_has_many",
    },
    {
      id: "b->triggers->d",
      type: "triggers",
      from: { entity: "entity_b" },
      to: { entity: "entity_d" },
      source: "event_handler",
    },
    {
      id: "c->affects->d",
      type: "affects",
      from: { entity: "entity_c" },
      to: { entity: "entity_d" },
      source: "bridge_definition",
    },
  ];
}

// ── Tests ────────────────────────────────────────────────

describe("analyzeImpact", () => {
  it("detects direct impacts (depth 0)", () => {
    const result = analyzeImpact("entity_a", linearChain());

    expect(result.source).toBe("entity_a");
    expect(result.directImpacts.length).toBe(1);
    expect(result.directImpacts[0]!.entity).toBe("entity_b");
    expect(result.directImpacts[0]!.depth).toBe(0);
    expect(result.directImpacts[0]!.path).toEqual(["entity_a", "entity_b"]);
    expect(result.directImpacts[0]!.relationTypes).toEqual(["references"]);
  });

  it("detects indirect/cascading impacts through chain", () => {
    const result = analyzeImpact("entity_a", linearChain());

    expect(result.indirectImpacts.length).toBe(2);
    const entities = result.indirectImpacts.map((n) => n.entity).sort();
    expect(entities).toEqual(["entity_c", "entity_d"]);

    // entity_c is at depth 1
    const nodeC = result.indirectImpacts.find((n) => n.entity === "entity_c")!;
    expect(nodeC.depth).toBe(1);
    expect(nodeC.path).toEqual(["entity_a", "entity_b", "entity_c"]);
    expect(nodeC.relationTypes).toEqual(["references", "triggers"]);

    // entity_d is at depth 2
    const nodeD = result.indirectImpacts.find((n) => n.entity === "entity_d")!;
    expect(nodeD.depth).toBe(2);
  });

  it("handles cycles without infinite loop", () => {
    const result = analyzeImpact("entity_a", cyclicGraph());

    // Should visit all 3 nodes (a is source, b and c are impacts)
    expect(result.totalAffected).toBe(2);
    const allEntities = [
      ...result.directImpacts.map((n) => n.entity),
      ...result.indirectImpacts.map((n) => n.entity),
    ].sort();
    expect(allEntities).toEqual(["entity_b", "entity_c"]);
  });

  it("respects maxDepth limit", () => {
    const result = analyzeImpact("entity_a", linearChain(), { maxDepth: 1 });

    // Only depth 0 and depth 1 should be found
    expect(result.directImpacts.length).toBe(1);
    expect(result.indirectImpacts.length).toBe(1);
    expect(result.indirectImpacts[0]!.entity).toBe("entity_c");
    // entity_d should NOT be included (depth 2)
    const allEntities = [
      ...result.directImpacts.map((n) => n.entity),
      ...result.indirectImpacts.map((n) => n.entity),
    ];
    expect(allEntities).not.toContain("entity_d");
  });

  it("handles branching graph correctly", () => {
    const result = analyzeImpact("entity_a", branchingGraph());

    // Direct: b, c
    expect(result.directImpacts.length).toBe(2);
    const directEntities = result.directImpacts.map((n) => n.entity).sort();
    expect(directEntities).toEqual(["entity_b", "entity_c"]);

    // Indirect: d (reachable via both b and c, but only counted once)
    expect(result.indirectImpacts.length).toBe(1);
    expect(result.indirectImpacts[0]!.entity).toBe("entity_d");
  });

  it("returns empty results for isolated node", () => {
    const result = analyzeImpact("entity_z", linearChain());
    expect(result.directImpacts).toEqual([]);
    expect(result.indirectImpacts).toEqual([]);
    expect(result.totalAffected).toBe(0);
  });

  it("includes capability info when available", () => {
    const result = analyzeImpact("entity_a", linearChain());
    expect(result.directImpacts[0]!.capability).toBe("cap_b");
  });

  it("reports correct maxDepth and totalAffected", () => {
    const result = analyzeImpact("entity_a", linearChain());
    expect(result.maxDepth).toBe(2);
    expect(result.totalAffected).toBe(3);
  });
});
