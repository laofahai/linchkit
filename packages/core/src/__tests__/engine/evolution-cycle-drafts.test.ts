/**
 * persistCycleProposalsAsDrafts — evolution-cycle → governance-draft bridge tests.
 *
 * Asserts the SAFE-side contract (Spec 55 §7):
 *   (a) every cycle proposal becomes a `draft` in the shared ProposalEngine;
 *   (b) re-running the same cycle does NOT create duplicate drafts;
 *   (c) nothing is submitted / approved — status stays `draft`;
 *   (d) the returned summary `{ created, deduped, total }` is accurate;
 *   (e) within-batch duplicates are collapsed;
 *   (f) structurally-distinct proposals on the same capability are NOT deduped.
 */

import { describe, expect, test } from "bun:test";
import { persistCycleProposalsAsDrafts } from "../../engine/evolution-cycle-drafts";
import { createProposalEngine } from "../../engine/proposal-engine";
import type { ProposalDefinition } from "../../types/proposal";

// ── Fixtures ──────────────────────────────────────────────

/**
 * Build a cycle-style ProposalDefinition (as `EvolutionCycleResult.proposals`
 * carries them). The id/status here are deliberately "live"-looking to prove
 * the helper never copies them — it always mints a fresh `draft`.
 */
function cycleProposal(overrides?: Partial<ProposalDefinition>): ProposalDefinition {
  const now = new Date();
  return {
    id: "cycle-source-id-should-be-ignored",
    title: "Add default for order.currency",
    description: "Detected USD in 95% of records",
    author: { type: "ai", id: "insight-translator", name: "Insight Translator" },
    capability: "order",
    changeType: "minor",
    changes: [
      { target: "rule", operation: "create", name: "order_currency_default", diff: "set USD" },
    ],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: ["order_currency_default"],
      dependentsAffected: [],
      migrationRequired: false,
    },
    // Source status is irrelevant — helper must never copy it.
    status: "validated",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe("persistCycleProposalsAsDrafts", () => {
  test("(a) each cycle proposal becomes a draft in the engine", () => {
    const engine = createProposalEngine();
    const proposals = [
      cycleProposal(),
      cycleProposal({
        title: "Add validation for invoice.total",
        capability: "invoice",
        changes: [
          { target: "rule", operation: "create", name: "invoice_total_positive", diff: ">0" },
        ],
      }),
    ];

    const result = persistCycleProposalsAsDrafts({ proposals, engine });

    expect(result.created).toBe(2);
    expect(result.deduped).toBe(0);
    expect(result.total).toBe(2);
    expect(result.createdIds).toHaveLength(2);

    const stored = engine.listProposals({});
    expect(stored).toHaveLength(2);
    // Every persisted proposal is a draft.
    for (const p of stored) {
      expect(p.status).toBe("draft");
    }
    // Engine assigned fresh ids — the source id is never reused.
    for (const id of result.createdIds) {
      expect(id).not.toBe("cycle-source-id-should-be-ignored");
    }
  });

  test("(b) re-running the same cycle does not create duplicates", () => {
    const engine = createProposalEngine();
    const proposals = [cycleProposal()];

    const first = persistCycleProposalsAsDrafts({ proposals, engine });
    expect(first.created).toBe(1);
    expect(first.deduped).toBe(0);

    // Re-run with structurally-identical proposals.
    const second = persistCycleProposalsAsDrafts({ proposals: [cycleProposal()], engine });
    expect(second.created).toBe(0);
    expect(second.deduped).toBe(1);
    expect(second.total).toBe(1);

    // Engine still holds exactly one draft.
    expect(engine.listProposals({})).toHaveLength(1);
    expect(engine.listProposals({ status: "draft" })).toHaveLength(1);
  });

  test("(c) nothing is submitted or approved — status stays draft", () => {
    const engine = createProposalEngine();
    persistCycleProposalsAsDrafts({ proposals: [cycleProposal()], engine });

    // No validated / approved / committed / deployed proposals exist.
    expect(engine.listProposals({ status: "validated" })).toHaveLength(0);
    expect(engine.listProposals({ status: "approved" })).toHaveLength(0);
    expect(engine.listProposals({ status: "committed" })).toHaveLength(0);
    expect(engine.listProposals({ status: "deployed" })).toHaveLength(0);
    // Every stored proposal is draft.
    expect(engine.listProposals({ status: "draft" })).toHaveLength(1);
  });

  test("(d) empty cycle produces a zero summary and persists nothing", () => {
    const engine = createProposalEngine();
    const result = persistCycleProposalsAsDrafts({ proposals: [], engine });
    expect(result).toEqual({ created: 0, deduped: 0, total: 0, createdIds: [] });
    expect(engine.listProposals({})).toHaveLength(0);
  });

  test("(e) within-batch structural duplicates are collapsed", () => {
    const engine = createProposalEngine();
    // Two structurally-identical proposals in ONE batch.
    const result = persistCycleProposalsAsDrafts({
      proposals: [cycleProposal(), cycleProposal()],
      engine,
    });
    expect(result.created).toBe(1);
    expect(result.deduped).toBe(1);
    expect(result.total).toBe(2);
    expect(engine.listProposals({})).toHaveLength(1);
  });

  test("(f) same capability but different changes are NOT deduped", () => {
    const engine = createProposalEngine();
    const result = persistCycleProposalsAsDrafts({
      proposals: [
        cycleProposal(),
        cycleProposal({
          changes: [
            { target: "rule", operation: "create", name: "order_status_required", diff: "req" },
          ],
        }),
      ],
      engine,
    });
    expect(result.created).toBe(2);
    expect(result.deduped).toBe(0);
    expect(engine.listProposals({})).toHaveLength(2);
  });

  test("(g) dedup ignores terminal-status proposals (rejected re-surfaces)", async () => {
    const engine = createProposalEngine();
    // Drive a seed to terminal "rejected" via the real lifecycle
    // (create → submit → reject). rejectProposal requires status "validated",
    // so the seed must be a payload that passes validation. Dedup keys on
    // capability + change NAMES (not target/operation), so a valid entity-create
    // whose change name matches cycleProposal()'s shares the same dedup key.
    const seed = engine.createProposal({
      title: "seed",
      description: "seed",
      author: { type: "ai", id: "x", name: "x" },
      capability: "order",
      changeType: "minor",
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order_currency_default",
          definition: { name: "order_currency_default", fields: { amount: { type: "number" } } },
        },
      ],
    });
    engine.submitProposal({ proposalId: seed.id });
    expect(engine.getProposal(seed.id).status).toBe("validated"); // guard: rejectable
    await engine.rejectProposal({ proposalId: seed.id, reason: "not now" });
    expect(engine.getProposal(seed.id).status).toBe("rejected");

    // The rejected seed is terminal (not pending), so an identical-keyed cycle
    // proposal must re-surface as a fresh draft rather than being deduped.
    const result = persistCycleProposalsAsDrafts({ proposals: [cycleProposal()], engine });
    expect(result.created).toBe(1);
    expect(result.deduped).toBe(0);
  });

  test("(h) dedup includes approved (not-yet-graduated) proposals", async () => {
    const engine = createProposalEngine();
    // An approved-but-not-graduated proposal is accepted work — re-running the
    // cycle must NOT re-surface a duplicate draft for it. Drive a same-keyed
    // seed to "approved" via the real lifecycle.
    const seed = engine.createProposal({
      title: "seed",
      description: "seed",
      author: { type: "ai", id: "x", name: "x" },
      capability: "order",
      changeType: "minor",
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order_currency_default",
          definition: { name: "order_currency_default", fields: { amount: { type: "number" } } },
        },
      ],
    });
    engine.submitProposal({ proposalId: seed.id });
    expect(engine.getProposal(seed.id).status).toBe("validated");
    await engine.approveProposal({
      proposalId: seed.id,
      approvedBy: { type: "human", id: "admin" },
    });
    expect(engine.getProposal(seed.id).status).toBe("approved");

    const result = persistCycleProposalsAsDrafts({ proposals: [cycleProposal()], engine });
    expect(result.created).toBe(0);
    expect(result.deduped).toBe(1);
  });
});
