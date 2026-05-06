/**
 * Proposal Pre-Analysis public surface (Spec 55 §7.3).
 *
 * Ships stages 1 (dedup), 2 (conflict), 3 (impact), and 4 (backtest).
 */

export type {
  BacktestDataProvider,
  CreateBacktestAnalyzerOptions,
} from "./backtest-analyzer";
export { createBacktestAnalyzer } from "./backtest-analyzer";
export type {
  CreateConflictAnalyzerOptions,
  LiveRuleStore,
  LiveStateStore,
} from "./conflict-analyzer";
export { createConflictAnalyzer } from "./conflict-analyzer";
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
