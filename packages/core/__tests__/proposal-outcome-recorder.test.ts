/**
 * Tests for ProposalOutcomeRecorder (Spec 55 §7.7 feedback loop).
 *
 * Uses InMemoryMemoryStore to capture written signals without real I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  createProposalOutcomeRecorder,
  type ProposalOutcomePayload,
  ProposalOutcomeRecorder,
} from "../src/engine/proposal-outcome-recorder";
import { InMemoryMemoryStore } from "../src/life-system/in-memory-memory-store";
import type { Signal } from "../src/types/life-system";
import type { Logger } from "../src/types/logger";
import type { ProposalDefinition, SuccessMetric } from "../src/types/proposal";

// ── Fixtures ─────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-05-27T10:00:00.000Z");

function makeProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  return {
    id: "proposal-test-abc123",
    title: "Auto-approve low-risk orders",
    description: "Generated from insight #42.",
    author: { type: "ai", id: "insight-translator", name: "Insight Translator" },
    capability: "cap-life-demo",
    changeType: "minor",
    changes: [],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "approved",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    approvedAt: FIXED_NOW,
    approvedBy: { type: "human", id: "admin-1" },
    ...overrides,
  };
}

function extractPayload(signal: Signal): ProposalOutcomePayload {
  return signal.payload as ProposalOutcomePayload;
}

async function firstSignal(store: InMemoryMemoryStore): Promise<Signal> {
  const signals = await store.getSignals();
  const signal = signals[0];
  if (!signal) throw new Error("Expected at least one signal in store");
  return signal;
}

// ── Core behaviour ────────────────────────────────────────────

describe("ProposalOutcomeRecorder", () => {
  describe("recordOutcome — accepted", () => {
    it("writes a proposal.outcome.accepted signal to the store", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal();

      await recorder.recordOutcome(proposal, "accepted");

      const signals = await store.getSignals();
      expect(signals).toHaveLength(1);
      const signal = await firstSignal(store);
      expect(signal.type).toBe("proposal.outcome.accepted");
      expect(signal.source).toBe("event_bus");
      expect(signal.timestamp).toBeInstanceOf(Date);
    });

    it("payload carries proposalId, outcome, capability, changeType, authorType, authorId", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal();

      await recorder.recordOutcome(proposal, "accepted");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.proposalId).toBe("proposal-test-abc123");
      expect(payload.outcome).toBe("accepted");
      expect(payload.capability).toBe("cap-life-demo");
      expect(payload.changeType).toBe("minor");
      expect(payload.authorType).toBe("ai");
      expect(payload.authorId).toBe("insight-translator");
    });

    it("payload includes approvedBy for accepted outcomes", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({ approvedBy: { type: "human", id: "admin-1" } });

      await recorder.recordOutcome(proposal, "accepted");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.approvedBy).toEqual({ type: "human", id: "admin-1" });
      expect(payload.rejectionReason).toBeUndefined();
    });

    it("payload includes proposalCreatedAt as ISO string", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({ createdAt: FIXED_NOW });

      await recorder.recordOutcome(proposal, "accepted");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.proposalCreatedAt).toBe(FIXED_NOW.toISOString());
    });
  });

  describe("recordOutcome — rejected", () => {
    it("payload carries rejectionReason and no approvedBy", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({
        status: "rejected",
        rejectionReason: "Risk too high for this quarter",
      });

      await recorder.recordOutcome(proposal, "rejected");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.outcome).toBe("rejected");
      expect(payload.rejectionReason).toBe("Risk too high for this quarter");
      expect(payload.approvedBy).toBeUndefined();
    });
  });

  describe("recordOutcome — merged", () => {
    it("writes a merged signal with basic fields", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({ status: "committed" });

      await recorder.recordOutcome(proposal, "merged");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.outcome).toBe("merged");
      expect(payload.proposalId).toBe("proposal-test-abc123");
    });

    it("stamps mergedSha onto the merged payload (Spec 55 §7.7 rollback loop)", async () => {
      // Slice B: the commitSha returned by ProposalGitCommitter is the SHA source
      // and enters the rollback chain here, on the merged outcome payload.
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({ status: "committed" });

      await recorder.recordOutcome(proposal, "merged", { mergedSha: "abc1234def" });

      const payload = extractPayload(await firstSignal(store));
      expect(payload.mergedSha).toBe("abc1234def");
    });

    it("leaves mergedSha undefined on a merged payload when none supplied", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({ status: "committed" });

      await recorder.recordOutcome(proposal, "merged");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.mergedSha).toBeUndefined();
    });

    it("ignores mergedSha for a non-merged outcome and warns", async () => {
      const store = new InMemoryMemoryStore();
      const warnings: string[] = [];
      const logger = { warn: (msg: string) => warnings.push(msg) } as unknown as Logger;
      const recorder = new ProposalOutcomeRecorder({ store, logger });
      const proposal = makeProposal();

      await recorder.recordOutcome(proposal, "accepted", { mergedSha: "abc1234def" });

      const payload = extractPayload(await firstSignal(store));
      expect(payload.mergedSha).toBeUndefined();
      expect(warnings.some((w) => w.includes("ignoring mergedSha"))).toBe(true);
    });
  });

  describe("recordOutcome — withdrawn", () => {
    it("writes a withdrawn signal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({ status: "draft" });

      await recorder.recordOutcome(proposal, "withdrawn");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.outcome).toBe("withdrawn");
      expect(payload.approvedBy).toBeUndefined();
      expect(payload.rejectionReason).toBeUndefined();
    });
  });

  describe("successMetric propagation", () => {
    it("carries successMetric in payload when present", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const metric: SuccessMetric = {
        description: "Purchase failure rate drops below 1%",
        signalRef: "action_failure_rate",
        insightRef: "insight-42",
        baselineValue: 4.2,
        targetValue: 1.0,
        unit: "%",
      };
      const proposal = makeProposal({ successMetric: metric });

      await recorder.recordOutcome(proposal, "accepted");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.successMetric).toEqual(metric);
    });

    it("successMetric is undefined in payload when not set", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal();

      await recorder.recordOutcome(proposal, "accepted");

      const payload = extractPayload(await firstSignal(store));
      expect(payload.successMetric).toBeUndefined();
    });
  });

  describe("multiple outcomes", () => {
    it("each call writes an independent signal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const p1 = makeProposal({ id: "p-001" });
      const p2 = makeProposal({ id: "p-002", status: "rejected", rejectionReason: "out of scope" });

      await recorder.recordOutcome(p1, "accepted");
      await recorder.recordOutcome(p2, "rejected");

      const signals = await store.getSignals();
      expect(signals).toHaveLength(2);
      const s0 = signals[0];
      const s1 = signals[1];
      if (!s0 || !s1) throw new Error("Expected two signals");
      expect(extractPayload(s0).proposalId).toBe("p-001");
      expect(extractPayload(s0).outcome).toBe("accepted");
      expect(extractPayload(s1).proposalId).toBe("p-002");
      expect(extractPayload(s1).outcome).toBe("rejected");
    });
  });

  describe("onApprovedHook()", () => {
    it("returns a function compatible with ProposalEngine.onApproved", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const hook = recorder.onApprovedHook();
      const proposal = makeProposal();

      await hook(proposal);

      const payload = extractPayload(await firstSignal(store));
      expect(payload.outcome).toBe("accepted");
      expect(payload.proposalId).toBe("proposal-test-abc123");
    });

    it("each invocation of the hook records a new signal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const hook = recorder.onApprovedHook();
      const p1 = makeProposal({ id: "hook-p-001" });
      const p2 = makeProposal({ id: "hook-p-002" });

      await hook(p1);
      await hook(p2);

      expect(await store.getSignals()).toHaveLength(2);
    });
  });

  describe("createProposalOutcomeRecorder factory", () => {
    it("returns a ProposalOutcomeRecorder instance", () => {
      const store = new InMemoryMemoryStore();
      const recorder = createProposalOutcomeRecorder({ store });
      expect(recorder).toBeInstanceOf(ProposalOutcomeRecorder);
    });
  });

  describe("logger integration", () => {
    it("calls logger.info on successful outcome recording", async () => {
      const store = new InMemoryMemoryStore();
      const infoArgs: Array<[string, ...unknown[]]> = [];
      const logger: Logger = {
        debug: () => {},
        info: (msg: string, ...rest: unknown[]) => {
          infoArgs.push([msg, ...(rest as unknown[])]);
        },
        warn: () => {},
        error: () => {},
      };
      const recorder = new ProposalOutcomeRecorder({ store, logger });
      const proposal = makeProposal();

      await recorder.recordOutcome(proposal, "accepted");

      expect(infoArgs.length).toBe(1);
      expect(infoArgs[0]?.[0]).toContain("accepted");
      expect(infoArgs[0]?.[0]).toContain("proposal-test-abc123");
    });
  });
});
