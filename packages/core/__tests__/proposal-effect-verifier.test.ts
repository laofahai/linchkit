import { describe, expect, it } from "bun:test";
import {
  createProposalEffectVerifier,
  ProposalEffectVerifier,
} from "../src/engine/proposal-effect-verifier";
import type { ProposalOutcomePayload } from "../src/engine/proposal-outcome-recorder";
import { InMemoryMemoryStore } from "../src/life-system/in-memory-memory-store";

// ── Helpers ───────────────────────────────────────────────

function makePayload(overrides: Partial<ProposalOutcomePayload> = {}): ProposalOutcomePayload {
  return {
    proposalId: "prop-abc-001",
    proposalTitle: "Reduce manual edit rate",
    capability: "cap-supplier",
    changeType: "minor",
    outcome: "merged",
    authorId: "user-1",
    authorType: "human",
    ...overrides,
  };
}

async function storeBaseline(
  store: InMemoryMemoryStore,
  entity: string,
  metric: string,
  value: number,
): Promise<void> {
  await store.updateBaseline({ entity, metric, value, calculatedAt: new Date() });
}

// ── factory ───────────────────────────────────────────────

describe("ProposalEffectVerifier", () => {
  describe("factory", () => {
    it("createProposalEffectVerifier returns a ProposalEffectVerifier", () => {
      const store = new InMemoryMemoryStore();
      const verifier = createProposalEffectVerifier({ store });
      expect(verifier).toBeInstanceOf(ProposalEffectVerifier);
    });
  });

  // ── effect_uncertain — insufficient data ─────────────────

  describe("verify — effect_uncertain", () => {
    it("returns effect_uncertain when successMetric is missing", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(makePayload());

      expect(result.status).toBe("effect_uncertain");
      expect(result.proposalId).toBe("prop-abc-001");
    });

    it("returns effect_uncertain when successMetric has no signalRef", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(
        makePayload({ successMetric: { description: "Reduce rate", baseline: 78, target: 20 } }),
      );

      expect(result.status).toBe("effect_uncertain");
    });

    it("returns effect_uncertain when successMetric has no baseline", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(
        makePayload({
          successMetric: { description: "Reduce rate", signalRef: "entity.metric", target: 20 },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
    });

    it("returns effect_uncertain when successMetric has no target", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(
        makePayload({
          successMetric: { description: "Reduce rate", signalRef: "entity.metric", baseline: 78 },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
    });

    it("returns effect_uncertain when signalRef has no dot", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "nodot",
            baseline: 78,
            target: 20,
          },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
    });

    it("returns effect_uncertain when signalRef starts with dot", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(
        makePayload({
          successMetric: { description: "x", signalRef: ".metric", baseline: 78, target: 20 },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
    });

    it("returns effect_uncertain when signalRef ends with dot", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(
        makePayload({
          successMetric: { description: "x", signalRef: "entity.", baseline: 78, target: 20 },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
    });

    it("returns effect_uncertain when no baseline in store", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
          },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
      expect(result.currentValue).toBeUndefined();
    });

    it("returns effect_uncertain when target equals baseline", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 50);

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "supplier.edit_rate",
            baseline: 50,
            target: 50,
          },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
      expect(result.currentValue).toBe(50);
    });
  });

  // ── effect_verified — decrease goal ──────────────────────

  describe("verify — effect_verified (decrease)", () => {
    it("returns effect_verified when current reaches target (decrease goal)", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 18); // below target of 20

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "Edit rate < 20%",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
            unit: "%",
          },
        }),
      );

      expect(result.status).toBe("effect_verified");
      expect(result.currentValue).toBe(18);
      expect(result.rollbackInsight).toBeUndefined();
    });

    it("returns effect_verified when current exactly equals target (decrease)", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 20);

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
          },
        }),
      );

      expect(result.status).toBe("effect_verified");
    });
  });

  // ── effect_verified — increase goal ──────────────────────

  describe("verify — effect_verified (increase)", () => {
    it("returns effect_verified when current reaches target (increase goal)", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "task", "completion_rate", 95); // above target of 90

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "Completion rate > 90%",
            signalRef: "task.completion_rate",
            baseline: 60,
            target: 90,
            unit: "%",
          },
        }),
      );

      expect(result.status).toBe("effect_verified");
      expect(result.currentValue).toBe(95);
      expect(result.rollbackInsight).toBeUndefined();
    });

    it("returns effect_verified when current exactly equals target (increase)", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "task", "completion_rate", 90);

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "task.completion_rate",
            baseline: 60,
            target: 90,
          },
        }),
      );

      expect(result.status).toBe("effect_verified");
    });
  });

  // ── effect_uncertain — improving but not at target ───────

  describe("verify — effect_uncertain (improving)", () => {
    it("returns effect_uncertain when improving toward lower target but not there yet", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 50); // between baseline 78 and target 20

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
          },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
      expect(result.currentValue).toBe(50);
    });

    it("returns effect_uncertain when improving toward higher target but not there yet", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "task", "completion_rate", 75); // between baseline 60 and target 90

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "task.completion_rate",
            baseline: 60,
            target: 90,
          },
        }),
      );

      expect(result.status).toBe("effect_uncertain");
      expect(result.currentValue).toBe(75);
    });
  });

  // ── effect_failed — regression ───────────────────────────

  describe("verify — effect_failed (regression)", () => {
    it("returns effect_failed when value regressed below baseline (decrease goal)", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 90); // worse than baseline 78

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "Edit rate < 20%",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
          },
        }),
      );

      expect(result.status).toBe("effect_failed");
      expect(result.currentValue).toBe(90);
    });

    it("returns effect_failed when value regressed below baseline (increase goal)", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "task", "completion_rate", 50); // worse than baseline 60

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "task.completion_rate",
            baseline: 60,
            target: 90,
          },
        }),
      );

      expect(result.status).toBe("effect_failed");
      expect(result.currentValue).toBe(50);
    });
  });

  // ── rollbackInsight ───────────────────────────────────────

  describe("verify — rollbackInsight on effect_failed", () => {
    it("includes rollbackInsight when effect_failed", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 90);

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "Edit rate < 20%",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
          },
        }),
      );

      expect(result.rollbackInsight).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: verified defined above
      const insight = result.rollbackInsight!;
      expect(insight.type).toBe("anomaly");
      expect(insight.impact).toBe("high");
      expect(insight.causality).toBe("causal");
      expect(insight.entity).toBe("supplier");
      expect(insight.tags).toContain("rollback_candidate");
    });

    it("rollbackInsight summary mentions the proposal title", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 90);

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
          },
        }),
      );

      // biome-ignore lint/style/noNonNullAssertion: verified by effect_failed
      expect(result.rollbackInsight!.summary).toContain("Reduce manual edit rate");
    });

    it("rollbackInsight evidence.baseline matches store baseline", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 90);

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
          },
        }),
      );

      // biome-ignore lint/style/noNonNullAssertion: verified by effect_failed
      expect(result.rollbackInsight!.evidence.baseline?.value).toBe(90);
    });

    it("rollbackInsight has unique id", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 90);

      const payload = makePayload({
        successMetric: {
          description: "x",
          signalRef: "supplier.edit_rate",
          baseline: 78,
          target: 20,
        },
      });

      const r1 = await verifier.verify(payload);
      const r2 = await verifier.verify(payload);

      // biome-ignore lint/style/noNonNullAssertion: verified by effect_failed
      expect(r1.rollbackInsight!.id).not.toBe(r2.rollbackInsight!.id);
    });

    it("does NOT include rollbackInsight when effect_verified", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "edit_rate", 15);

      const result = await verifier.verify(
        makePayload({
          successMetric: {
            description: "x",
            signalRef: "supplier.edit_rate",
            baseline: 78,
            target: 20,
          },
        }),
      );

      expect(result.status).toBe("effect_verified");
      expect(result.rollbackInsight).toBeUndefined();
    });

    it("does NOT include rollbackInsight when effect_uncertain", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });

      const result = await verifier.verify(makePayload());

      expect(result.status).toBe("effect_uncertain");
      expect(result.rollbackInsight).toBeUndefined();
    });
  });

  // ── Insight.tags field on Insight type ───────────────────

  describe("Insight.tags", () => {
    it("Insight type accepts tags field", () => {
      const insight = {
        id: "test",
        type: "anomaly" as const,
        confidence: 0.9,
        impact: "high" as const,
        evidence: { signals: [], context: {} },
        summary: "test",
        causality: "causal" as const,
        entity: "entity",
        createdAt: new Date(),
        tags: ["rollback_candidate", "custom"],
      };
      expect(insight.tags).toContain("rollback_candidate");
    });

    it("Insight type is valid without tags (backward compat)", () => {
      const insight = {
        id: "test",
        type: "anomaly" as const,
        confidence: 0.9,
        impact: "high" as const,
        evidence: { signals: [], context: {} },
        summary: "test",
        causality: "causal" as const,
        entity: "entity",
        createdAt: new Date(),
      };
      expect(insight.tags).toBeUndefined();
    });
  });

  // ── proposalId in all results ─────────────────────────────

  describe("verify — result always includes proposalId", () => {
    it("includes proposalId in effect_uncertain result", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      const result = await verifier.verify(makePayload({ proposalId: "my-proposal-42" }));
      expect(result.proposalId).toBe("my-proposal-42");
    });

    it("includes proposalId in effect_verified result", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "rate", 15);

      const result = await verifier.verify(
        makePayload({
          proposalId: "prop-xyz",
          successMetric: { description: "x", signalRef: "supplier.rate", baseline: 78, target: 20 },
        }),
      );
      expect(result.proposalId).toBe("prop-xyz");
    });

    it("includes proposalId in effect_failed result", async () => {
      const store = new InMemoryMemoryStore();
      const verifier = new ProposalEffectVerifier({ store });
      await storeBaseline(store, "supplier", "rate", 90);

      const result = await verifier.verify(
        makePayload({
          proposalId: "prop-fail",
          successMetric: { description: "x", signalRef: "supplier.rate", baseline: 78, target: 20 },
        }),
      );
      expect(result.proposalId).toBe("prop-fail");
    });
  });
});
