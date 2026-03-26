// AI Audit
export type {
  AIAuditEntry,
  AIAuditEventType,
  AIAuditLoggerOptions,
  AIAuditQueryOptions,
  AIAuditRiskLevel,
} from "./ai-audit";
export { AIAuditLogger } from "./ai-audit";
export type { AIBoundaryOptions } from "./ai-boundary";
export { AIBoundary, AIBoundaryError } from "./ai-boundary";
export type {
  AIActionAccess,
  AIBoundaryCheckResult,
  AIBudget,
  AIBudgetConfig,
  AICallRequest,
  AIContentFilter,
  AIPolicy,
  AIRateLimits,
  AIUsageRecord,
} from "./ai-policy";
export {
  createAIService,
  createNoopAIService,
  defaultAIConfig,
  resolveLanguageModel,
  resolveModel,
  resolveModelRoute,
  resolveTenantConfig,
} from "./ai-service";

// Cost Estimator
export type { ModelPricing } from "./cost-estimator";
export { CostEstimator, defaultCostEstimator } from "./cost-estimator";

// Response Cache
export { AIResponseCache } from "./response-cache";

// Prompt Sanitizer
export type {
  InjectionDetectionConfig,
  InjectionDetectionResult,
  InjectionPattern,
  PIIPattern,
  PIISanitizationConfig,
  PIISanitizationResult,
  PIIType,
  PromptSanitizerOptions,
  SanitizationResult,
} from "./prompt-sanitizer";
export {
  detectInjection,
  sanitizePII,
  sanitizePrompt,
  sanitizeRecordForAI,
} from "./prompt-sanitizer";

// Output Validator
export type {
  OutputValidationResult,
  OutputValidationRule,
  OutputValidatorConfig,
  OutputViolation,
  OutputViolationSeverity,
  OutputViolationType,
} from "./output-validator";
export { sanitizeAIOutput, validateAIOutput } from "./output-validator";

// Proposal Validator
export type {
  ProposalChange,
  ProposalChangeType,
  ProposalCustomRule,
  ProposalRiskLevel,
  ProposalValidationResult,
  ProposalValidatorConfig,
  ProposalViolation,
} from "./proposal-validator";
export { createProposalValidator, validateProposal } from "./proposal-validator";

// Anomaly Detector
export type {
  AnomalyDetection,
  AnomalyDetectorConfig,
  AnomalySeverity,
  AnomalyType,
  UsageEvent,
} from "./anomaly-detector";
export { AnomalyDetector } from "./anomaly-detector";

// Pattern Detector
export type {
  PatternDetectorConfig,
  PatternEvidence,
  PatternInsight,
  PatternType,
} from "./pattern-detector";
export { PatternDetector } from "./pattern-detector";

// Proposal Engine
export type {
  AIProposalStatus,
  Proposal,
  ProposalDiff,
  ProposalDraft,
  ProposalEngineOptions,
  ProposalType,
} from "./proposal-engine";
export { ProposalEngine } from "./proposal-engine";
