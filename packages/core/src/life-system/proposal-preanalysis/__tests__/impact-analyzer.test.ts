import { describe, expect, test } from "bun:test";
import { createImpactAnalyzer } from "../impact-analyzer";
import type { ImpactDataProvider } from "../types";
import { makeProposal } from "./fixtures";

function makeProvider(
  records: Record<string, string[]>,
): ImpactDataProvider & { calls: { entity: string; kind: "count" | "sample" }[] } {
  const calls: { entity: string; kind: "count" | "sample" }[] = [];
  return {
    calls,
    async countRecords(entity) {
      calls.push({ entity, kind: "count" });
      return records[entity]?.length ?? 0;
    },
    async sampleRecordIds(entity, limit) {
      calls.push({ entity, kind: "sample" });
      return (records[entity] ?? []).slice(0, limit);
    },
  };
}

describe("createImpactAnalyzer", () => {
  test("returns zero with reason=not-a-data-change for code-only proposals", async () => {
    const provider = makeProvider({});
    const analyzer = createImpactAnalyzer({ dataProvider: provider });
    const proposal = makeProposal({
      changes: [
        {
          target: "view",
          operation: "create",
          name: "purchase_request_list",
          diff: "add default sort",
        },
      ],
    });

    const result = await analyzer.analyze(proposal);

    expect(result.affectedRecordCount).toBe(0);
    expect(result.sampleRecordIds).toHaveLength(0);
    expect(result.probedEntities).toHaveLength(0);
    expect(result.reason).toBe("not-a-data-change");
    expect(provider.calls).toHaveLength(0);
  });

  test("returns count + sample ids for entity-target data changes", async () => {
    const provider = makeProvider({
      purchase_request: ["pr_1", "pr_2", "pr_3", "pr_4", "pr_5", "pr_6", "pr_7"],
    });
    const analyzer = createImpactAnalyzer({ dataProvider: provider, sampleLimit: 5 });
    const proposal = makeProposal();

    const result = await analyzer.analyze(proposal);

    expect(result.affectedRecordCount).toBe(7);
    expect(result.sampleRecordIds).toEqual(["pr_1", "pr_2", "pr_3", "pr_4", "pr_5"]);
    expect(result.probedEntities).toEqual(["purchase_request"]);
    expect(result.reason).toBeUndefined();
  });

  test("handles overlay targets by extracting entityName from the definition", async () => {
    const provider = makeProvider({ order: ["o_1", "o_2"] });
    const analyzer = createImpactAnalyzer({ dataProvider: provider });
    const proposal = makeProposal({
      changes: [
        {
          target: "overlay",
          operation: "create",
          name: "order_overlay",
          definition: {
            kind: "overlay",
            entityName: "order",
            overlay: { fieldName: "priority", overrides: {} },
          } as never,
        },
      ],
    });

    const result = await analyzer.analyze(proposal);

    expect(result.affectedRecordCount).toBe(2);
    expect(result.probedEntities).toEqual(["order"]);
  });

  test("aggregates counts and samples across multiple data-change entities", async () => {
    const provider = makeProvider({
      purchase_request: ["pr_1", "pr_2"],
      order: ["o_1", "o_2", "o_3"],
    });
    const analyzer = createImpactAnalyzer({ dataProvider: provider, sampleLimit: 4 });
    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          diff: "add priority",
        },
        {
          target: "state",
          operation: "create",
          // State-machine name, NOT the entity name; the entity lives on
          // StateDefinition.entity (see Spec 07).
          name: "order_lifecycle",
          definition: { name: "order_lifecycle", entity: "order" } as never,
          diff: "add state machine",
        },
      ],
    });

    const result = await analyzer.analyze(proposal);

    expect(result.affectedRecordCount).toBe(5);
    expect(result.probedEntities).toEqual(["purchase_request", "order"]);
    expect(result.sampleRecordIds).toHaveLength(4);
    expect(result.sampleRecordIds.slice(0, 2)).toEqual(["pr_1", "pr_2"]);
  });

  test("deduplicates entity probes when multiple changes share the same entity", async () => {
    const provider = makeProvider({ purchase_request: ["pr_1"] });
    const analyzer = createImpactAnalyzer({ dataProvider: provider });
    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          diff: "add priority",
        },
        {
          target: "state",
          operation: "create",
          name: "purchase_request_status",
          definition: { name: "purchase_request_status", entity: "purchase_request" } as never,
          diff: "add state machine",
        },
      ],
    });

    const result = await analyzer.analyze(proposal);

    expect(result.probedEntities).toEqual(["purchase_request"]);
    expect(provider.calls.filter((c) => c.kind === "count")).toHaveLength(1);
  });

  test("creating a brand-new entity produces zero first-order impact", async () => {
    const provider = makeProvider({});
    const analyzer = createImpactAnalyzer({ dataProvider: provider });
    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "new_shiny_entity",
          diff: "add new entity",
        },
      ],
    });

    const result = await analyzer.analyze(proposal);

    // No pre-existing rows to probe — must not call the DataProvider.
    expect(result.affectedRecordCount).toBe(0);
    expect(result.probedEntities).toHaveLength(0);
    expect(result.reason).toBe("not-a-data-change");
    expect(provider.calls).toHaveLength(0);
  });

  test("returns zero with reason when a data-target change has no resolvable entity", async () => {
    const provider = makeProvider({});
    const analyzer = createImpactAnalyzer({ dataProvider: provider });
    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "", // unresolvable
          diff: "no-op",
        },
      ],
    });

    const result = await analyzer.analyze(proposal);

    expect(result.affectedRecordCount).toBe(0);
    expect(result.probedEntities).toHaveLength(0);
    expect(result.reason).toBe("entity-unresolved");
  });
});
