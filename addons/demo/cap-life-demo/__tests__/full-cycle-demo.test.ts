/**
 * End-to-end test for the full Spec 55 life-system demo.
 *
 * Drives `runFullCycleDemo()` once and asserts the observable cycle output:
 *   - Sense layer produced one signal
 *   - Awareness surfaced a `schema_no_view` structural insight
 *   - InsightTranslator emitted exactly one proposal targeting a view create
 *   - Pre-analysis pipeline ran and attached dedup + impact envelopes
 */

import { describe, expect, test } from "bun:test";
import { runFullCycleDemo } from "../src/full-cycle-demo";

describe("runFullCycleDemo (Spec 55 full loop)", () => {
  test("produces insights, proposals, and pre-analysis envelopes in one run", async () => {
    const fixedTimestamp = new Date("2026-05-08T00:00:00.000Z");
    const { cycle, proposalAnalyses } = await runFullCycleDemo({
      timestamp: fixedTimestamp,
    });

    // Sense + Memory: one synthetic signal collected and ingested.
    expect(cycle.signalsCollected).toBe(1);

    // Awareness + Insight: schema_no_view structural insight surfaced.
    const structural = cycle.newInsights.filter((i) => i.type === "structural");
    expect(structural).toHaveLength(1);
    expect(structural[0]?.entity).toBe("synthetic_metric");

    // Proposal: default registry translates the insight into a view-create change.
    expect(cycle.proposals).toHaveLength(1);
    const proposal = cycle.proposals[0];
    if (!proposal) throw new Error("expected proposal");
    expect(proposal.capability).toBe("cap-life-demo");
    expect(proposal.changes).toHaveLength(1);
    const change = proposal.changes[0];
    if (!change) throw new Error("expected change");
    expect(change.target).toBe("view");
    expect(change.operation).toBe("create");
    // Cycle timestamp propagates through to the proposal's createdAt stamp,
    // proving the translator context inherited the SensorContext.timestamp.
    expect(proposal.createdAt.getTime()).toBe(fixedTimestamp.getTime());

    // Pre-analysis: dedup + impact envelopes attached to every proposal.
    expect(proposalAnalyses).toHaveLength(1);
    const analysis = proposalAnalyses[0];
    if (!analysis) throw new Error("expected analysis");
    expect(analysis.proposal.id).toBe(proposal.id);
    expect(analysis.preAnalysis.stages.dedup?.status).toBe("ok");
    expect(analysis.preAnalysis.stages.impact?.status).toBe("ok");
    // No prior proposals + view target → empty similar list, code-only impact.
    expect(analysis.preAnalysis.stages.dedup?.data?.similar).toEqual([]);
    expect(analysis.preAnalysis.stages.dedup?.data?.exactMatch).toBeNull();
    expect(analysis.preAnalysis.stages.impact?.data?.affectedRecordCount).toBe(0);
    expect(analysis.preAnalysis.stages.impact?.data?.reason).toBe("not-a-data-change");
    expect(analysis.preAnalysis.allStagesSucceeded).toBe(true);
  });

  test("two consecutive runs produce identical proposal counts (idempotent setup)", async () => {
    // Each call constructs fresh engines, so the structural promotion key
    // can't leak between runs. Both runs should emit exactly one proposal.
    const a = await runFullCycleDemo();
    const b = await runFullCycleDemo();
    expect(a.cycle.proposals).toHaveLength(1);
    expect(b.cycle.proposals).toHaveLength(1);
    expect(a.proposalAnalyses).toHaveLength(1);
    expect(b.proposalAnalyses).toHaveLength(1);
  });
});
