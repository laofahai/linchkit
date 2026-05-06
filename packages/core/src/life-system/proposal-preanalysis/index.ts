/**
 * Proposal Pre-Analysis public surface (Spec 55 §7.3).
 *
 * Ships stages 1 (dedup), 3 (impact), and 4 (backtest). Types for stage 2
 * (conflict) are exported so a follow-up analyzer can plug into the pipeline
 * without touching core.
 */

export type {
  BacktestDataProvider,
  CreateBacktestAnalyzerOptions,
} from "./backtest-analyzer";
export { createBacktestAnalyzer } from "./backtest-analyzer";
export type { CreateDedupAnalyzerOptions } from "./dedup-analyzer";
export { createDedupAnalyzer } from "./dedup-analyzer";
export type { CreateImpactAnalyzerOptions } from "./impact-analyzer";
export { createImpactAnalyzer } from "./impact-analyzer";
export type { CreatePreAnalysisPipelineOptions } from "./pipeline";
export { createPreAnalysisPipeline } from "./pipeline";
export type {
  BacktestResult,
  ConflictFinding,
  ConflictResult,
  DedupResult,
  ImpactDataProvider,
  ImpactResult,
  PendingProposalStore,
  PreAnalysisPipeline,
  PreAnalysisStage,
  PreAnalysisStageResult,
  PreAnalysisStatus,
  PreAnalyzer,
  ProposalPreAnalysisResult,
} from "./types";
