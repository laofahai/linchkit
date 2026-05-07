import { describe, expect, it } from "bun:test";
import {
  createDefaultInsightTranslatorRegistry,
  createInsightTranslatorRegistry,
  insightTranslatorKey,
  schemaNoViewTranslator,
} from "../../life-system/insight-to-proposal";
import type { Insight } from "../../types/life-system";
import type { ViewDefinition } from "../../types/view";

const FROZEN_NOW = new Date("2026-05-07T00:00:00.000Z");

const makeStructuralInsight = (overrides: Partial<Insight> = {}): Insight => ({
  id: "insight_1",
  type: "structural",
  confidence: 1.0,
  impact: "low",
  evidence: {
    signals: [],
    context: { kind: "schema_no_view", target: undefined },
  },
  summary: 'Schema "purchase_request" has no view defined.',
  causality: "structural",
  entity: "purchase_request",
  createdAt: FROZEN_NOW,
  ...overrides,
});

describe("insightTranslatorKey", () => {
  it("builds structural keys from evidence.context.kind", () => {
    const insight = makeStructuralInsight();
    expect(insightTranslatorKey(insight)).toBe("structural:schema_no_view");
  });

  it("falls back to a sentinel when structural kind is missing", () => {
    const insight = makeStructuralInsight({
      evidence: { signals: [], context: {} },
    });
    expect(insightTranslatorKey(insight)).toBe("structural:unknown");
  });

  it("uses bare insight type for non-structural insights", () => {
    const insight: Insight = {
      ...makeStructuralInsight(),
      type: "anomaly",
      causality: "correlational",
    };
    expect(insightTranslatorKey(insight)).toBe("anomaly");
  });
});

describe("schemaNoViewTranslator", () => {
  it("emits an add-view ProposalDefinition tracing back to the insight", async () => {
    const insight = makeStructuralInsight();
    const proposal = await schemaNoViewTranslator(insight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_test_1",
    });

    expect(proposal).not.toBeNull();
    if (!proposal) throw new Error("expected proposal");

    expect(proposal.id).toBe("proposal_test_1");
    expect(proposal.status).toBe("draft");
    expect(proposal.changeType).toBe("minor");
    expect(proposal.capability).toBe("evolution");
    expect(proposal.author).toEqual({
      type: "ai",
      id: "insight-translator",
      name: "Insight Translator",
    });
    expect(proposal.createdAt).toBe(FROZEN_NOW);
    expect(proposal.updatedAt).toBe(FROZEN_NOW);
    expect(proposal.description).toBe(insight.summary);
    expect(proposal.title).toContain("purchase_request");

    expect(proposal.changes).toHaveLength(1);
    const change = proposal.changes[0];
    if (!change) throw new Error("expected one change");
    expect(change.target).toBe("view");
    expect(change.operation).toBe("create");
    expect(change.name).toBe("purchase_request_default_list");

    const def = change.definition as ViewDefinition;
    expect(def.entity).toBe("purchase_request");
    expect(def.type).toBe("list");
    expect(Array.isArray(def.fields)).toBe(true);

    expect(proposal.impact.schemasAffected).toEqual(["purchase_request"]);
    expect(proposal.impact.migrationRequired).toBe(false);

    // Evidence is attached as a sidecar that traces back to the insight.
    const sidecar = (proposal as unknown as { evidence: { context: Record<string, unknown> } })
      .evidence;
    expect(sidecar).toBeDefined();
    expect(sidecar.context.insightId).toBe(insight.id);
    expect(sidecar.context.kind).toBe("schema_no_view");
  });

  it("returns null for non-structural insights", async () => {
    const insight: Insight = {
      ...makeStructuralInsight(),
      type: "anomaly",
      causality: "correlational",
    };
    const result = await schemaNoViewTranslator(insight, {});
    expect(result).toBeNull();
  });

  it("returns null when structural kind is not schema_no_view", async () => {
    const insight = makeStructuralInsight({
      evidence: { signals: [], context: { kind: "rule_never_triggered" } },
    });
    const result = await schemaNoViewTranslator(insight, {});
    expect(result).toBeNull();
  });

  it("does not mutate the originating insight evidence", async () => {
    const original = makeStructuralInsight();
    const beforeContext = { ...original.evidence.context };
    await schemaNoViewTranslator(original, {});
    expect(original.evidence.context).toEqual(beforeContext);
    // Translator-side context mutation must not have leaked back.
    expect((original.evidence.context as { insightId?: string }).insightId).toBeUndefined();
  });
});

describe("InsightTranslatorRegistry", () => {
  it("translates via the registered translator", async () => {
    const registry = createInsightTranslatorRegistry();
    registry.register("structural:schema_no_view", schemaNoViewTranslator);

    const insight = makeStructuralInsight();
    const result = await registry.translate(insight);
    expect(result).not.toBeNull();
    expect(result?.changes[0]?.target).toBe("view");
  });

  it("returns null for unsupported insight kinds without throwing", async () => {
    const registry = createInsightTranslatorRegistry();
    registry.register("structural:schema_no_view", schemaNoViewTranslator);

    const unsupported = makeStructuralInsight({
      id: "insight_unsupported",
      evidence: { signals: [], context: { kind: "field_constant_value" } },
      summary: "Field is always the same value.",
    });
    const result = await registry.translate(unsupported);
    expect(result).toBeNull();
  });

  it("supports register / unregister / has / keys", () => {
    const registry = createInsightTranslatorRegistry();
    expect(registry.has("structural:schema_no_view")).toBe(false);

    registry.register("structural:schema_no_view", schemaNoViewTranslator);
    expect(registry.has("structural:schema_no_view")).toBe(true);
    expect(registry.keys()).toContain("structural:schema_no_view");

    registry.unregister("structural:schema_no_view");
    expect(registry.has("structural:schema_no_view")).toBe(false);
  });

  it("default registry is pre-loaded with the structural schema_no_view translator", async () => {
    const registry = createDefaultInsightTranslatorRegistry();
    expect(registry.has("structural:schema_no_view")).toBe(true);

    const insight = makeStructuralInsight();
    const result = await registry.translate(insight, {
      now: () => FROZEN_NOW,
      idGenerator: () => "proposal_default_1",
    });
    expect(result?.id).toBe("proposal_default_1");
  });

  it("a translator that returns null does not throw and propagates null", async () => {
    const registry = createInsightTranslatorRegistry();
    registry.register("structural:schema_no_view", () => null);
    const insight = makeStructuralInsight();
    const result = await registry.translate(insight);
    expect(result).toBeNull();
  });
});
