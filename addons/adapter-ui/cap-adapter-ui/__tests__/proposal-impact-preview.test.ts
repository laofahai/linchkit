/**
 * Tests for ProposalImpactPreview helpers (Spec 55 §7.3).
 *
 * The component itself is JSX-only — we test the pure data-shaping helpers
 * since the existing test setup is logic-only (no happy-dom / jsdom). The
 * helpers cover every branch the component renders:
 *   - tone derivation per stage status / conflict kind
 *   - conflict grouping by `kind`
 *   - summarizing a full / partial / null pipeline result
 */

import { describe, expect, test } from "bun:test";
import type {
  ConflictFinding,
  ProposalDefinition,
  ProposalPreAnalysisResult,
} from "@linchkit/core";
import {
  groupConflicts,
  STAGE_ORDER,
  summarizePreAnalysis,
  toneForConflict,
  toneForStatus,
} from "../src/components/proposal-impact-preview-helpers";

// ── Fixtures ────────────────────────────────────────────────

const NOW = new Date("2026-05-06T00:00:00Z");

function makeProposal(id: string): ProposalDefinition {
  return {
    id,
    title: `Proposal ${id}`,
    description: "fixture",
    author: { type: "ai", id: "ai", name: "AI" },
    capability: "demo",
    changeType: "minor",
    changes: [],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const findings: ConflictFinding[] = [
  { kind: "rule", targetId: "rule.a", message: "rule a" },
  { kind: "state_transition", targetId: "state.b", message: "state b" },
  { kind: "proposal", targetId: "prop.c", message: "prop c" },
  { kind: "other", targetId: "x", message: "other x" },
  { kind: "rule", targetId: "rule.d", message: "rule d" },
];

// ── Stage order ────────────────────────────────────────────

describe("STAGE_ORDER", () => {
  test("matches Spec 55 §7.3 canonical order", () => {
    expect(STAGE_ORDER).toEqual(["dedup", "conflict", "impact", "backtest"]);
  });
});

// ── toneForStatus ──────────────────────────────────────────

describe("toneForStatus", () => {
  test("ok → success", () => {
    expect(toneForStatus("ok")).toBe("success");
  });

  test("error → error", () => {
    expect(toneForStatus("error")).toBe("error");
  });

  test("skipped → muted", () => {
    expect(toneForStatus("skipped")).toBe("muted");
  });

  test("undefined → muted (defensive default)", () => {
    expect(toneForStatus(undefined)).toBe("muted");
  });
});

// ── toneForConflict ────────────────────────────────────────

describe("toneForConflict", () => {
  test("rule kind escalates to error", () => {
    expect(toneForConflict({ kind: "rule", targetId: "r", message: "" })).toBe("error");
  });

  test("state_transition stays warning", () => {
    expect(toneForConflict({ kind: "state_transition", targetId: "s", message: "" })).toBe(
      "warning",
    );
  });

  test("proposal stays warning", () => {
    expect(toneForConflict({ kind: "proposal", targetId: "p", message: "" })).toBe("warning");
  });

  test("other stays warning", () => {
    expect(toneForConflict({ kind: "other", targetId: "x", message: "" })).toBe("warning");
  });
});

// ── groupConflicts ─────────────────────────────────────────

describe("groupConflicts", () => {
  test("groups by kind preserving input order within each group", () => {
    const grouped = groupConflicts(findings);
    expect(grouped.rule.map((f) => f.targetId)).toEqual(["rule.a", "rule.d"]);
    expect(grouped.state_transition.map((f) => f.targetId)).toEqual(["state.b"]);
    expect(grouped.proposal.map((f) => f.targetId)).toEqual(["prop.c"]);
    expect(grouped.other.map((f) => f.targetId)).toEqual(["x"]);
  });

  test("empty input yields empty groups", () => {
    const grouped = groupConflicts([]);
    expect(grouped.rule).toEqual([]);
    expect(grouped.state_transition).toEqual([]);
    expect(grouped.proposal).toEqual([]);
    expect(grouped.other).toEqual([]);
  });
});

// ── summarizePreAnalysis ───────────────────────────────────

describe("summarizePreAnalysis", () => {
  test("null result → empty summary (defensive)", () => {
    expect(summarizePreAnalysis(null)).toEqual({
      hasData: false,
      ranCount: 0,
      errorCount: 0,
      skippedCount: 0,
      totalFindings: 0,
    });
  });

  test("undefined result → empty summary (defensive)", () => {
    expect(summarizePreAnalysis(undefined)).toEqual({
      hasData: false,
      ranCount: 0,
      errorCount: 0,
      skippedCount: 0,
      totalFindings: 0,
    });
  });

  test("counts errors, skipped, and total findings across stages", () => {
    const result: ProposalPreAnalysisResult = {
      proposalId: "p1",
      analyzedAt: NOW,
      totalDurationMs: 50,
      allStagesSucceeded: false,
      stages: {
        dedup: {
          stage: "dedup",
          status: "ok",
          durationMs: 10,
          data: {
            payloadHash: "h",
            exactMatch: null,
            similar: [makeProposal("a"), makeProposal("b")],
          },
        },
        conflict: {
          stage: "conflict",
          status: "ok",
          durationMs: 10,
          data: {
            conflicts: [
              { kind: "rule", targetId: "r", message: "" },
              { kind: "proposal", targetId: "p", message: "" },
            ],
          },
        },
        impact: {
          stage: "impact",
          status: "error",
          durationMs: 5,
          error: { code: "X", message: "boom" },
        },
        backtest: { stage: "backtest", status: "skipped", durationMs: 0 },
      },
    };
    const summary = summarizePreAnalysis(result);
    expect(summary).toEqual({
      hasData: true,
      ranCount: 4,
      errorCount: 1,
      skippedCount: 1,
      totalFindings: 4, // 2 dedup + 2 conflict
    });
  });

  test("missing stages are not counted as ran", () => {
    const result: ProposalPreAnalysisResult = {
      proposalId: "p2",
      analyzedAt: NOW,
      totalDurationMs: 5,
      allStagesSucceeded: true,
      stages: {
        dedup: {
          stage: "dedup",
          status: "ok",
          durationMs: 5,
          data: { payloadHash: "h", exactMatch: null, similar: [] },
        },
      },
    };
    const summary = summarizePreAnalysis(result);
    expect(summary.ranCount).toBe(1);
    expect(summary.errorCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
    expect(summary.totalFindings).toBe(0);
    expect(summary.hasData).toBe(true);
  });

  test("skipped/error stages contribute zero findings even with no data", () => {
    const result: ProposalPreAnalysisResult = {
      proposalId: "p3",
      analyzedAt: NOW,
      totalDurationMs: 0,
      allStagesSucceeded: false,
      stages: {
        dedup: { stage: "dedup", status: "skipped", durationMs: 0 },
        conflict: {
          stage: "conflict",
          status: "error",
          durationMs: 0,
          error: { code: "E", message: "bad" },
        },
      },
    };
    const summary = summarizePreAnalysis(result);
    expect(summary.totalFindings).toBe(0);
    expect(summary.errorCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
  });

  test("ok stage with missing data is tolerated (no crash)", () => {
    // Defensive: an analyzer reporting status=ok but no data field shouldn't
    // explode the summarizer. The shape stays valid because the helper guards
    // on `stage.data` truthiness before reading shape-specific arrays.
    const result: ProposalPreAnalysisResult = {
      proposalId: "p4",
      analyzedAt: NOW,
      totalDurationMs: 0,
      allStagesSucceeded: true,
      stages: {
        dedup: { stage: "dedup", status: "ok", durationMs: 0 },
      },
    };
    const summary = summarizePreAnalysis(result);
    expect(summary.totalFindings).toBe(0);
    expect(summary.ranCount).toBe(1);
  });
});
