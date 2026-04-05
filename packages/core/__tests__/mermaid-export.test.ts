import { describe, expect, it } from "bun:test";
import { generateSemanticMermaid } from "../src/ontology/mermaid-export";
import type { SemanticRelation } from "../src/types/semantic-relation";

// ── Fixtures ─────────────────────────────────────────────

function sampleRelations(): SemanticRelation[] {
  return [
    {
      id: "order->refs->customer",
      type: "references",
      from: { capability: "sales", entity: "order" },
      to: { capability: "crm", entity: "customer" },
      source: "schema_ref",
    },
    {
      id: "order->contains->order_line",
      type: "contains",
      from: { capability: "sales", entity: "order" },
      to: { capability: "sales", entity: "order_line" },
      source: "schema_has_many",
    },
    {
      id: "order->triggers->invoice",
      type: "triggers",
      from: { capability: "sales", entity: "order" },
      to: { capability: "accounting", entity: "invoice" },
      source: "event_handler",
    },
    {
      id: "invoice->affects->payment",
      type: "affects",
      from: { capability: "accounting", entity: "invoice" },
      to: { capability: "accounting", entity: "payment" },
      source: "bridge_definition",
    },
  ];
}

// ── Tests ────────────────────────────────────────────────

describe("generateSemanticMermaid", () => {
  it("generates valid Mermaid graph LR syntax", () => {
    const output = generateSemanticMermaid(sampleRelations());

    expect(output).toStartWith("graph LR");
    expect(output).toContain("order");
    expect(output).toContain("customer");
  });

  it("uses correct edge labels for relation types", () => {
    const output = generateSemanticMermaid(sampleRelations());

    expect(output).toContain("|references|");
    expect(output).toContain("|contains|");
    expect(output).toContain("|triggers|");
    expect(output).toContain("|affects|");
  });

  it("uses solid arrows for structural relations", () => {
    const output = generateSemanticMermaid([
      {
        id: "a->refs->b",
        type: "references",
        from: { entity: "a" },
        to: { entity: "b" },
        source: "schema_ref",
      },
    ]);

    // "references" is structural → solid arrow -->
    expect(output).toContain("-->|references|");
  });

  it("uses dashed arrows for semantic relations", () => {
    const output = generateSemanticMermaid([
      {
        id: "a->triggers->b",
        type: "triggers",
        from: { entity: "a" },
        to: { entity: "b" },
        source: "event_handler",
      },
    ]);

    // "triggers" is semantic → dashed arrow -.->
    expect(output).toContain("-.->|triggers|");
  });

  it("filters by focus entity (2 hops)", () => {
    const output = generateSemanticMermaid(sampleRelations(), { focus: "invoice" });

    // invoice is connected to: order (1 hop), payment (1 hop)
    // 2 hops from invoice: customer, order_line (via order)
    expect(output).toContain("invoice");
    expect(output).toContain("order");
    expect(output).toContain("payment");
  });

  it("respects maxNodes limit", () => {
    const output = generateSemanticMermaid(sampleRelations(), { maxNodes: 2 });

    // Only 2 nodes should be present
    const nodeMatches = output.match(/\[(\w+)\]/g) ?? [];
    const uniqueNodes = new Set(nodeMatches.map((m) => m.slice(1, -1)));
    expect(uniqueNodes.size).toBeLessThanOrEqual(2);
  });

  it("handles empty relation list", () => {
    const output = generateSemanticMermaid([]);
    expect(output).toBe("graph LR");
  });

  it("sanitizes node IDs with special characters", () => {
    const output = generateSemanticMermaid([
      {
        id: "a->refs->b",
        type: "references",
        from: { entity: "my-entity" },
        to: { entity: "other.entity" },
        source: "schema_ref",
      },
    ]);

    // Special chars should be replaced with underscores in IDs
    expect(output).toContain("my_entity[my-entity]");
    expect(output).toContain("other_entity[other.entity]");
  });
});
