// AI Audit

// AI Action Audit Store
export type { AIActionAuditEntry, AIActionAuditQueryOptions } from "./ai-action-audit-store";
export { AIActionAuditStore } from "./ai-action-audit-store";
export type {
  AIAuditEntry,
  AIAuditEventType,
  AIAuditLoggerOptions,
  AIAuditQueryOptions,
  AIAuditRiskLevel,
  IntentResolutionAuditPayload,
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
// Rate Limiter
export type {
  AIRateLimiterConfig,
  RateLimitResult,
  RateLimitWindow,
} from "./ai-rate-limiter";
export { AIRateLimiter } from "./ai-rate-limiter";
export { createNoopAIService } from "./ai-service";
// Anomaly Detector — moved to @linchkit/cap-ai-provider (Spec 56 Phase 2 Step 2c).
// Context Masker
export type {
  ContextMaskerConfig,
  ContextMaskingRule,
  MaskingResult,
} from "./context-masker";
export { MaskingSession, maskContext, maskRecord, unmaskContext } from "./context-masker";
// Conversation Manager
export type {
  AISession,
  AISessionContext,
  AISessionMessage,
  ConversationManagerOptions,
} from "./conversation-manager";
export { ConversationManager } from "./conversation-manager";
// Intent Resolver (Spec 52 §2.2 / §2.5 — NL → discriminated Intent)
export type { IntentCatalogEntry, IntentPromptOptions } from "./intent-prompt";
export { buildIntentSystemPrompt } from "./intent-prompt";
export type {
  IntentOntology,
  ResolveIntentDeps,
  ResolveIntentInput,
} from "./intent-resolver";
export {
  ALTERNATIVES_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_HISTORY_MESSAGES,
  extractFirstJsonObject,
  MAX_ALTERNATIVES,
  MIN_CONFIDENCE,
  resolveIntent,
} from "./intent-resolver";
export type {
  Intent,
  IntentAlternative,
  IntentClarification,
  IntentHistoryMessage,
  IntentMatch,
  IntentMultiStep,
  IntentNoMatch,
  IntentResolverOptions,
  IntentSlot,
  IntentStep,
} from "./intent-types";
// Message Formatter
export type { AIMessageBlock, AIRichMessage } from "./message-formatter";
export { formatRichMessage, parseRichMessage } from "./message-formatter";
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
// Pattern Detector — moved to @linchkit/cap-ai-provider (Spec 56 Phase 2 Step 2c).
// Core retains only the data contract consumed by ProposalEngine.
export type { PatternEvidence, PatternInsight, PatternType } from "./pattern-insight";
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
// Proposal Code Generator
export {
  type CodeGenerationProvider,
  type CodeGenerationResult,
  type ProjectContext,
  ProposalCodeGenerator,
  type QualityGateRunner,
} from "./proposal-code-generator";
// Proposal Compatibility Checker (Spec 09 Phase 3)
export {
  buildCompatibilitySnapshot,
  compatibilityCheck,
} from "./proposal-compatibility-checker";
export type {
  CompatibilityChange,
  CompatibilityIssue,
  CompatibilityRegistrySnapshot,
  CompatibilityResult,
  CompatibilitySeverity,
  EntityCreateChange,
  EntityDeleteChange,
  EntityReference,
  EntityRenameChange,
  EnumOptionsChange,
  FieldAddChange,
  FieldConstraintChange,
  FieldDropChange,
  FieldTypeChange,
} from "./proposal-compatibility-types";
// Proposal Dry-Run (Spec 09 Phase 4)
export type {
  DryRunModelError,
  DryRunResult,
  DryRunSideEffects,
} from "./proposal-dry-run";
export { dryRunProposal } from "./proposal-dry-run";
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
// Extended Proposal Validator (Spec 09 4-phase pipeline)
export type {
  ExtendedPhaseStatus,
  ExtendedPhaseSummary,
  ExtendedValidationResult,
  ExtendedValidatorConfig,
  ExtendedValidatorInput,
} from "./proposal-validator-extended";
export {
  createExtendedProposalValidator,
  validateProposalExtended,
} from "./proposal-validator-extended";
// Record Analyzer
export type {
  RecordAnalysis,
  RecordAnalysisRequest,
  RecordInsight,
} from "./record-analyzer";
export { analyzeRecord, buildAnalysisPrompt, parseAnalysisResponse } from "./record-analyzer";
