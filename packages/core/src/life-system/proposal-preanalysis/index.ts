/**
 * Proposal Pre-Analysis public surface (Spec 55 §7.3).
 *
 * Ships stages 1 (dedup) and 3 (impact). Types for stages 2 (conflict) and 4
 * (backtest) are exported so follow-up analyzers can plug into the pipeline
 * without touching core.
 */

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
