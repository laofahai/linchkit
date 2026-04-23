/**
 * PreAnalysisPipeline — Spec 55 §7.3 composer.
 *
 * Runs a list of analyzers against a proposal and aggregates their per-stage
 * results into a single ProposalPreAnalysisResult. Design rules:
 *
 *   - Analyzer failures are captured into the envelope (status === "error");
 *     the remaining analyzers still run. One bad analyzer must never nuke the pipeline.
 *   - Each stage may appear at most once. If two analyzers share a stage the first
 *     wins and the second is recorded as "skipped" so the situation is visible.
 *   - Analyzers run sequentially. The stages are cheap; ordering keeps test output
 *     deterministic and makes debugging easier than Promise.all interleaving.
 */

import type { ProposalDefinition } from "../../types/proposal";
import type {
  PreAnalysisPipeline,
  PreAnalysisStage,
  PreAnalysisStageResult,
  PreAnalysisStatus,
  PreAnalyzer,
  ProposalPreAnalysisResult,
} from "./types";

export interface CreatePreAnalysisPipelineOptions {
  /** Analyzers to run. Order preserved; duplicates per stage are skipped. */
  analyzers: ReadonlyArray<PreAnalyzer<PreAnalysisStage, unknown>>;
  /**
   * Optional clock — injectable for tests. Defaults to `() => new Date()` and
   * `() => performance.now()` for wall-clock + durations.
   */
  now?: () => Date;
  /** Optional high-resolution timer for per-stage durations (ms). */
  nowMs?: () => number;
}

function defaultNow(): Date {
  return new Date();
}

function defaultNowMs(): number {
  // performance.now() is available in Bun and modern runtimes.
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return "analyzer_error";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown analyzer error";
  }
}

export function createPreAnalysisPipeline(
  opts: CreatePreAnalysisPipelineOptions,
): PreAnalysisPipeline {
  const now = opts.now ?? defaultNow;
  const nowMs = opts.nowMs ?? defaultNowMs;

  return {
    async analyze(proposal: ProposalDefinition): Promise<ProposalPreAnalysisResult> {
      const pipelineStart = nowMs();
      const analyzedAt = now();
      const stages: ProposalPreAnalysisResult["stages"] = {};
      const seenStages = new Set<PreAnalysisStage>();

      for (const analyzer of opts.analyzers) {
        const stageStart = nowMs();

        if (seenStages.has(analyzer.stage)) {
          // Duplicate stage — the first analyzer for this stage already ran and
          // its envelope is stored on `stages[stage]`. Preserve it; do NOT
          // overwrite with a skipped envelope (that would throw away real
          // dedup/impact data downstream consumers rely on).
          continue;
        }
        seenStages.add(analyzer.stage);

        let status: PreAnalysisStatus = "ok";
        let data: unknown;
        let error: PreAnalysisStageResult<unknown>["error"];

        try {
          data = await analyzer.analyze(proposal);
        } catch (err) {
          status = "error";
          error = { code: errorCode(err), message: errorMessage(err) };
        }

        const envelope: PreAnalysisStageResult<unknown> = {
          stage: analyzer.stage,
          status,
          data: status === "ok" ? data : undefined,
          error,
          durationMs: nowMs() - stageStart,
        };
        attachStage(stages, envelope);
      }

      const allStagesSucceeded =
        opts.analyzers.length > 0 && Object.values(stages).every((env) => env?.status === "ok");

      return {
        proposalId: proposal.id,
        analyzedAt,
        stages,
        allStagesSucceeded,
        totalDurationMs: nowMs() - pipelineStart,
      };
    },
  };
}

/** Attach a stage envelope onto the typed stages object using its declared stage name. */
function attachStage(
  stages: ProposalPreAnalysisResult["stages"],
  envelope: PreAnalysisStageResult<unknown>,
): void {
  switch (envelope.stage) {
    case "dedup":
      stages.dedup = envelope as PreAnalysisStageResult<never>;
      return;
    case "conflict":
      stages.conflict = envelope as PreAnalysisStageResult<never>;
      return;
    case "impact":
      stages.impact = envelope as PreAnalysisStageResult<never>;
      return;
    case "backtest":
      stages.backtest = envelope as PreAnalysisStageResult<never>;
      return;
  }
}
