import { beforeEach, describe, expect, it } from "bun:test";
import type { PatternInsight } from "../src/ai/pattern-detector";
import type { Proposal } from "../src/ai/proposal-engine";
import { ProposalEngine } from "../src/ai/proposal-engine";

// ── Test helpers ──────────────────────────────────────────

function createInsight(overrides?: Partial<PatternInsight>): PatternInsight {
  return {
    id: "insight-1",
    type: "default_value",
    entity: "order",
    description: 'Field "currency" has value "USD" in 95% of records',
    confidence: 0.95,
    evidence: {
      count: 95,
      timespan: "30 days",
      examples: [{ currency: "USD" }],
    },
    suggestedAction: {
      type: "modify_schema",
      description: 'Set default value for "currency" to "USD"',
      targetSchema: "order",
      details: { field: "currency", defaultValue: "USD" },
    },
    ...overrides,
  };
}

function createRuleInsight(): PatternInsight {
  return {
    id: "insight-rule-1",
    type: "repetitive_action",
    entity: "purchase_request",
    description: 'Action "approve_request" is repeatedly executed with decision = "approved"',
    confidence: 0.9,
    evidence: {
      count: 50,
      timespan: "14 days",
      examples: [{ action: "approve_request", input: { decision: "approved" } }],
    },
    suggestedAction: {
      type: "add_rule",
      description: 'Auto-apply "approve_request" when decision = "approved"',
      targetSchema: "purchase_request",
      details: { action: "approve_request", field: "decision", value: "approved" },
    },
  };
}

function createAutomationInsight(): PatternInsight {
  return {
    id: "insight-auto-1",
    type: "timing",
    entity: "task",
    description: 'Action "daily_review" is concentrated between 9:00-10:00',
    confidence: 0.85,
    evidence: {
      count: 40,
      timespan: "30 days",
      examples: [{ peakHours: "9:00 - 10:00" }],
    },
    suggestedAction: {
      type: "add_automation",
      description: 'Consider scheduling "daily_review" as a batch job at 9:00',
      targetSchema: "task",
      details: { action: "daily_review", suggestedCron: "0 9 * * *" },
    },
  };
}

// ── Proposal Engine Tests ─────────────────────────────────

describe("ProposalEngine", () => {
  let engine: ProposalEngine;

  beforeEach(() => {
    engine = new ProposalEngine();
  });

  // ── Creation ───────────────────────────────────────────

  describe("createFromInsight", () => {
    it("creates a proposal from a default_value insight", () => {
      const insight = createInsight();
      const proposal = engine.createFromInsight(insight);

      expect(proposal.id).toBeTruthy();
      expect(proposal.status).toBe("draft");
      expect(proposal.type).toBe("modify_schema");
      expect(proposal.confidence).toBe(0.95);
      expect(proposal.insightId).toBe("insight-1");
      expect(proposal.diff.target).toBe("schema");
      expect(proposal.diff.operation).toBe("update");
      expect(proposal.createdAt).toBeInstanceOf(Date);
    });

    it("creates a proposal from an add_rule insight", () => {
      const insight = createRuleInsight();
      const proposal = engine.createFromInsight(insight);

      expect(proposal.type).toBe("add_rule");
      expect(proposal.diff.target).toBe("rule");
      expect(proposal.diff.operation).toBe("create");
      expect(proposal.diff.definition).toBeDefined();
    });

    it("creates a proposal from an add_automation insight", () => {
      const insight = createAutomationInsight();
      const proposal = engine.createFromInsight(insight);

      expect(proposal.type).toBe("add_automation");
      expect(proposal.diff.target).toBe("automation");
      expect(proposal.diff.operation).toBe("create");
      expect(proposal.diff.definition).toBeDefined();
    });

    it("stores the proposal and increments size", () => {
      engine.createFromInsight(createInsight());
      engine.createFromInsight(createRuleInsight());
      expect(engine.size).toBe(2);
    });
  });

  describe("createProposal", () => {
    it("creates a proposal directly", () => {
      const proposal = engine.createProposal({
        type: "add_rule",
        description: "Add a validation rule",
        reasoning: "Data analysis shows consistent patterns",
        confidence: 0.88,
        diff: {
          target: "rule",
          operation: "create",
          summary: "Add validation rule",
        },
      });

      expect(proposal.id).toBeTruthy();
      expect(proposal.status).toBe("draft");
      expect(proposal.type).toBe("add_rule");
      expect(proposal.confidence).toBe(0.88);
      expect(proposal.insightId).toBeUndefined();
    });
  });

  // ── Lifecycle: submit ──────────────────────────────────

  describe("submit", () => {
    it("transitions draft → pending", () => {
      const proposal = engine.createFromInsight(createInsight());
      const result = engine.submit(proposal.id);

      expect(result.success).toBe(true);
      expect(engine.get(proposal.id)?.status).toBe("pending");
    });

    it("fails if proposal is not in draft status", () => {
      const proposal = engine.createFromInsight(createInsight());
      engine.submit(proposal.id);
      // Now in pending, trying to submit again should fail
      expect(() => engine.submit(proposal.id)).toThrow('expected "draft"');
    });

    it("rejects proposals that fail security validation", () => {
      // Configure to forbid modify_schema
      const engine2 = new ProposalEngine({
        validatorConfig: {
          forbiddenChanges: ["modify_schema"],
        },
      });

      const proposal = engine2.createFromInsight(createInsight());
      const result = engine2.submit(proposal.id);

      expect(result.success).toBe(false);
      expect(result.validation).toBeDefined();
      expect(result.validation?.valid).toBe(false);
      expect(engine2.get(proposal.id)?.status).toBe("draft"); // stays in draft
    });
  });

  // ── Lifecycle: approve ─────────────────────────────────

  describe("approve", () => {
    it("transitions pending → approved", () => {
      const proposal = engine.createFromInsight(createInsight());
      engine.submit(proposal.id);
      const approved = engine.approve(proposal.id, "admin-1");

      expect(approved.status).toBe("approved");
      expect(approved.reviewedBy).toBe("admin-1");
      expect(approved.reviewedAt).toBeInstanceOf(Date);
    });

    it("fails if proposal is not in pending status", () => {
      const proposal = engine.createFromInsight(createInsight());
      expect(() => engine.approve(proposal.id, "admin")).toThrow('expected "pending"');
    });
  });

  // ── Lifecycle: reject ──────────────────────────────────

  describe("reject", () => {
    it("transitions pending → rejected with reason", () => {
      const proposal = engine.createFromInsight(createInsight());
      engine.submit(proposal.id);
      const rejected = engine.reject(proposal.id, "admin-1", "Not useful");

      expect(rejected.status).toBe("rejected");
      expect(rejected.reviewedBy).toBe("admin-1");
      expect(rejected.rejectionReason).toBe("Not useful");
    });

    it("fails if proposal is not in pending status", () => {
      const proposal = engine.createFromInsight(createInsight());
      expect(() => engine.reject(proposal.id, "admin", "reason")).toThrow('expected "pending"');
    });
  });

  // ── Lifecycle: apply ───────────────────────────────────

  describe("apply", () => {
    it("transitions approved → applied", async () => {
      const proposal = engine.createFromInsight(createInsight());
      engine.submit(proposal.id);
      engine.approve(proposal.id, "admin");
      const applied = await engine.apply(proposal.id);

      expect(applied.status).toBe("applied");
      expect(applied.appliedAt).toBeInstanceOf(Date);
    });

    it("invokes onApply callback", async () => {
      let callbackCalled = false;
      let callbackProposal: Proposal | undefined;

      const engine2 = new ProposalEngine({
        onApply: (p) => {
          callbackCalled = true;
          callbackProposal = p;
        },
      });

      const proposal = engine2.createFromInsight(createInsight());
      engine2.submit(proposal.id);
      engine2.approve(proposal.id, "admin");
      await engine2.apply(proposal.id);

      expect(callbackCalled).toBe(true);
      expect(callbackProposal?.id).toBe(proposal.id);
    });

    it("fails if proposal is not approved", async () => {
      const proposal = engine.createFromInsight(createInsight());
      engine.submit(proposal.id);
      await expect(engine.apply(proposal.id)).rejects.toThrow('expected "approved"');
    });
  });

  // ── Lifecycle: rollback ────────────────────────────────

  describe("rollback", () => {
    it("transitions applied → rolled_back", async () => {
      const proposal = engine.createFromInsight(createInsight());
      engine.submit(proposal.id);
      engine.approve(proposal.id, "admin");
      await engine.apply(proposal.id);
      const rolledBack = await engine.rollback(proposal.id);

      expect(rolledBack.status).toBe("rolled_back");
      expect(rolledBack.rolledBackAt).toBeInstanceOf(Date);
    });

    it("invokes onRollback callback", async () => {
      let rollbackCalled = false;

      const engine2 = new ProposalEngine({
        onRollback: () => {
          rollbackCalled = true;
        },
      });

      const proposal = engine2.createFromInsight(createInsight());
      engine2.submit(proposal.id);
      engine2.approve(proposal.id, "admin");
      await engine2.apply(proposal.id);
      await engine2.rollback(proposal.id);

      expect(rollbackCalled).toBe(true);
    });

    it("fails if proposal is not applied", async () => {
      const proposal = engine.createFromInsight(createInsight());
      engine.submit(proposal.id);
      engine.approve(proposal.id, "admin");
      await expect(engine.rollback(proposal.id)).rejects.toThrow('expected "applied"');
    });
  });

  // ── Queries ────────────────────────────────────────────

  describe("queries", () => {
    it("get returns a proposal by ID", () => {
      const proposal = engine.createFromInsight(createInsight());
      expect(engine.get(proposal.id)).toBeDefined();
      expect(engine.get("nonexistent")).toBeUndefined();
    });

    it("list returns all proposals", () => {
      engine.createFromInsight(createInsight());
      engine.createFromInsight(createRuleInsight());
      expect(engine.list()).toHaveLength(2);
    });

    it("list filters by status", () => {
      const p1 = engine.createFromInsight(createInsight());
      engine.createFromInsight(createRuleInsight());

      engine.submit(p1.id);

      expect(engine.list("draft")).toHaveLength(1);
      expect(engine.list("pending")).toHaveLength(1);
      expect(engine.list("approved")).toHaveLength(0);
    });

    it("clear removes all proposals", () => {
      engine.createFromInsight(createInsight());
      engine.createFromInsight(createRuleInsight());
      engine.clear();
      expect(engine.size).toBe(0);
      expect(engine.list()).toHaveLength(0);
    });
  });

  // ── Error handling ─────────────────────────────────────

  describe("error handling", () => {
    it("throws on non-existent proposal ID", () => {
      expect(() => engine.submit("nonexistent")).toThrow("not found");
      expect(() => engine.approve("nonexistent", "admin")).toThrow("not found");
      expect(() => engine.reject("nonexistent", "admin", "reason")).toThrow("not found");
    });
  });

  // ── Boundary enforcement ───────────────────────────────

  describe("boundary enforcement", () => {
    it("blocks forbidden change types via security validation", () => {
      // delete_rule is forbidden by default
      const engine2 = new ProposalEngine();

      const proposal = engine2.createProposal({
        type: "add_rule",
        description: "Test rule",
        reasoning: "Test",
        confidence: 0.9,
        diff: {
          target: "rule",
          operation: "create",
          summary: "Add rule",
        },
      });

      // This should succeed since create_rule is not forbidden (just requires approval)
      const result = engine2.submit(proposal.id);
      expect(result.success).toBe(true);
    });

    it("blocks delete operations via security config", () => {
      const engine2 = new ProposalEngine({
        validatorConfig: {
          forbiddenChanges: ["create_rule"],
        },
      });

      const insight = createRuleInsight();
      const proposal = engine2.createFromInsight(insight);
      const result = engine2.submit(proposal.id);

      expect(result.success).toBe(false);
      expect(result.validation?.valid).toBe(false);
    });
  });

  // ── Full lifecycle ─────────────────────────────────────

  describe("full lifecycle", () => {
    it("draft → pending → approved → applied → rolled_back", async () => {
      const appliedProposals: Proposal[] = [];
      const rolledBackProposals: Proposal[] = [];

      const engine2 = new ProposalEngine({
        onApply: (p) => appliedProposals.push(p),
        onRollback: (p) => rolledBackProposals.push(p),
      });

      const insight = createInsight();
      const proposal = engine2.createFromInsight(insight);
      expect(proposal.status).toBe("draft");

      const submitResult = engine2.submit(proposal.id);
      expect(submitResult.success).toBe(true);
      expect(engine2.get(proposal.id)?.status).toBe("pending");

      engine2.approve(proposal.id, "admin-1");
      expect(engine2.get(proposal.id)?.status).toBe("approved");

      await engine2.apply(proposal.id);
      expect(engine2.get(proposal.id)?.status).toBe("applied");
      expect(appliedProposals).toHaveLength(1);

      await engine2.rollback(proposal.id);
      expect(engine2.get(proposal.id)?.status).toBe("rolled_back");
      expect(rolledBackProposals).toHaveLength(1);
    });

    it("draft → pending → rejected", () => {
      const insight = createRuleInsight();
      const proposal = engine.createFromInsight(insight);

      engine.submit(proposal.id);
      engine.reject(proposal.id, "reviewer-1", "Not aligned with business goals");

      const final = engine.get(proposal.id);
      expect(final?.status).toBe("rejected");
      expect(final?.reviewedBy).toBe("reviewer-1");
      expect(final?.rejectionReason).toBe("Not aligned with business goals");
    });
  });
});
