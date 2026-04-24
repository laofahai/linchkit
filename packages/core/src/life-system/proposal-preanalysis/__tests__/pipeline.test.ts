import { describe, expect, test } from "bun:test";
import { createDedupAnalyzer } from "../dedup-analyzer";
import { createImpactAnalyzer } from "../impact-analyzer";
import { createPreAnalysisPipeline } from "../pipeline";
import type {
  DedupResult,
  ImpactDataProvider,
  ImpactResult,
  PendingProposalStore,
  PreAnalysisStage,
  PreAnalyzer,
} from "../types";
import { makeProposal } from "./fixtures";

function emptyStore(): PendingProposalStore {
  return {
    async listPending() {
      return [];
    },
  };
}

function emptyProvider(): ImpactDataProvider {
  return {
    async countRecords() {
      return 0;
    },
    async sampleRecordIds() {
      return [];
    },
  };
}

describe("createPreAnalysisPipeline", () => {
  test("returns an empty result with no analyzers", async () => {
    const pipeline = createPreAnalysisPipeline({ analyzers: [] });
    const proposal = makeProposal();

    const result = await pipeline.analyze(proposal);

    expect(result.proposalId).toBe(proposal.id);
    expect(result.stages).toEqual({});
    expect(result.allStagesSucceeded).toBe(false);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("runs a single analyzer and records an ok envelope", async () => {
    const pipeline = createPreAnalysisPipeline({
      analyzers: [createDedupAnalyzer({ store: emptyStore() })],
    });
    const proposal = makeProposal();

    const result = await pipeline.analyze(proposal);

    expect(result.stages.dedup?.status).toBe("ok");
    expect(result.stages.dedup?.data?.similar).toHaveLength(0);
    expect(result.stages.impact).toBeUndefined();
    expect(result.allStagesSucceeded).toBe(true);
  });

  test("composes dedup + impact analyzers", async () => {
    const pipeline = createPreAnalysisPipeline({
      analyzers: [
        createDedupAnalyzer({ store: emptyStore() }),
        createImpactAnalyzer({ dataProvider: emptyProvider() }),
      ],
    });
    const proposal = makeProposal();

    const result = await pipeline.analyze(proposal);

    expect(result.stages.dedup?.status).toBe("ok");
    expect(result.stages.impact?.status).toBe("ok");
    expect(result.stages.impact?.data?.probedEntities).toEqual(["purchase_request"]);
    expect(result.allStagesSucceeded).toBe(true);
  });

  test("captures an analyzer error into the stage envelope without nuking the pipeline", async () => {
    const failingDedup: PreAnalyzer<"dedup", DedupResult> = {
      stage: "dedup",
      name: "failing-dedup",
      async analyze() {
        throw new Error("boom");
      },
    };
    const pipeline = createPreAnalysisPipeline({
      analyzers: [failingDedup, createImpactAnalyzer({ dataProvider: emptyProvider() })],
    });
    const proposal = makeProposal();

    const result = await pipeline.analyze(proposal);

    expect(result.stages.dedup?.status).toBe("error");
    expect(result.stages.dedup?.error?.message).toBe("boom");
    expect(result.stages.dedup?.data).toBeUndefined();

    // Second analyzer should still run successfully
    expect(result.stages.impact?.status).toBe("ok");
    expect(result.allStagesSucceeded).toBe(false);
  });

  test("propagates a structured error code when thrown error carries one", async () => {
    const failingImpact: PreAnalyzer<"impact", ImpactResult> = {
      stage: "impact",
      name: "failing-impact",
      async analyze() {
        const err = new Error("db offline") as Error & { code: string };
        err.code = "db_unavailable";
        throw err;
      },
    };
    const pipeline = createPreAnalysisPipeline({ analyzers: [failingImpact] });

    const result = await pipeline.analyze(makeProposal());

    expect(result.stages.impact?.status).toBe("error");
    expect(result.stages.impact?.error?.code).toBe("db_unavailable");
    expect(result.stages.impact?.error?.message).toBe("db offline");
  });

  test("preserves the first analyzer's result when a duplicate stage is queued", async () => {
    const a = createDedupAnalyzer({ store: emptyStore() });
    // Second dedup analyzer would explode if it ran — proves duplicates are
    // short-circuited without being invoked AND without overwriting the first.
    const b = {
      stage: "dedup" as const,
      name: "explodes",
      analyze: async () => {
        throw new Error("second dedup analyzer must not run");
      },
    };
    const pipeline = createPreAnalysisPipeline({ analyzers: [a, b] });

    const result = await pipeline.analyze(makeProposal());

    // First analyzer's real envelope must survive — the second is skipped silently.
    expect(result.stages.dedup?.status).toBe("ok");
    expect(result.stages.dedup?.error).toBeUndefined();
    expect(result.allStagesSucceeded).toBe(true);
  });

  test("records durations and an analyzedAt timestamp from injected clocks", async () => {
    let ms = 1000;
    const tick = () => {
      const t = ms;
      ms += 5;
      return t;
    };
    const fixedDate = new Date("2026-04-23T12:00:00Z");
    const pipeline = createPreAnalysisPipeline({
      analyzers: [createDedupAnalyzer({ store: emptyStore() })],
      now: () => fixedDate,
      nowMs: tick,
    });

    const result = await pipeline.analyze(makeProposal());

    expect(result.analyzedAt).toEqual(fixedDate);
    expect(result.stages.dedup?.durationMs).toBe(5);
    expect(result.totalDurationMs).toBeGreaterThan(0);
  });

  test("handles a custom analyzer that returns data of arbitrary shape", async () => {
    const customStage: PreAnalysisStage = "conflict";
    const conflictAnalyzer: PreAnalyzer<"conflict", { conflicts: [] }> = {
      stage: customStage,
      name: "stub-conflict",
      async analyze() {
        return { conflicts: [] };
      },
    };
    const pipeline = createPreAnalysisPipeline({ analyzers: [conflictAnalyzer] });

    const result = await pipeline.analyze(makeProposal());

    expect(result.stages.conflict?.status).toBe("ok");
    expect(result.stages.conflict?.data).toEqual({ conflicts: [] });
  });
});
