/**
 * serializeProposal — JSON serialization for the proposal read endpoints.
 *
 * Asserts that the per-proposal pre-analysis (`ProposalDefinition.analysis`,
 * Spec 55 §7.3) surfaces in the serialized output so the review UI can show the
 * evidence/impact/backtest rationale behind an AI-surfaced proposal, and that it
 * is absent (undefined) for proposals created without a pre-analysis.
 */

import { describe, expect, test } from "bun:test";
import type { ProposalDefinition, ProposalPreAnalysisResult } from "@linchkit/core";
import { serializeProposal } from "../src/proposal-api";

// ── Fixtures ─────────────────────────────────────────────────

function makeProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const now = new Date();
  return {
    id: "prop-1",
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
    status: "draft",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAnalysis(): ProposalPreAnalysisResult {
  return {
    proposalId: "prop-1",
    analyzedAt: new Date(),
    stages: {
      impact: {
        stage: "impact",
        status: "ok",
        data: { affectedRecordCount: 42, sampleRecordIds: ["r1"], probedEntities: ["order"] },
        durationMs: 2,
      },
    },
    allStagesSucceeded: true,
    totalDurationMs: 2,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("serializeProposal", () => {
  test("includes the analysis field when present", () => {
    const analysis = makeAnalysis();
    const serialized = serializeProposal(makeProposal({ analysis }));

    expect(serialized.analysis).toBeDefined();
    const out = serialized.analysis as Record<string, unknown>;
    expect(out.proposalId).toBe("prop-1");
    expect(
      (out.stages as ProposalPreAnalysisResult["stages"]).impact?.data?.affectedRecordCount,
    ).toBe(42);
    // analyzedAt (the only Date field) must be an ISO string, consistent with
    // the rest of the serialized payload — not a raw Date object.
    expect(typeof out.analyzedAt).toBe("string");
    expect(out.analyzedAt).toBe(analysis.analyzedAt.toISOString());
  });

  test("omits analysis (undefined) when the proposal has none", () => {
    const serialized = serializeProposal(makeProposal());
    expect(serialized.analysis).toBeUndefined();
  });
});
