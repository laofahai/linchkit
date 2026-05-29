/**
 * AI runtime (server-only).
 *
 * - AI service: noop fallback for envs without a provider.
 * - AI boundary: heavyweight runtime classes that enforce policy/budget.
 * - AI audit logger: compliance audit trail.
 * - Prompt sanitizer: injection detection + PII redaction.
 * - Intent resolver: natural-language → discriminated Intent (Spec 52).
 * - Output validator: post-generation safety checks.
 * - Proposal validator: dry-run + compatibility checks against the registry.
 *
 * AI Pattern Detection concrete `PatternDetector` and AI Anomaly Detector
 * moved to @linchkit/cap-ai-provider (Spec 56 Phase 2 Step 2c); core
 * re-exports only the shared `PatternInsight` contract that
 * ProposalEngine.createFromInsight() consumes.
 */

// AI Boundary
export type { PatternEvidence, PatternInsight, PatternType } from "../../ai";
// AI Audit
// AI Prompt Sanitizer
// AI Intent Resolver (Spec 52 §2.2 / §2.5)
// AI Output Validator
// AI Proposal Validator
export {
  type AIAuditEntry,
  type AIAuditEventType,
  AIAuditLogger,
  type AIAuditLoggerOptions,
  type AIAuditQueryOptions,
  type AIAuditRiskLevel,
  AIBoundary,
  AIBoundaryError,
  ALTERNATIVES_CONFIDENCE_THRESHOLD as INTENT_ALTERNATIVES_CONFIDENCE_THRESHOLD,
  buildCompatibilitySnapshot,
  buildIntentSystemPrompt,
  type CompatibilityChange,
  type CompatibilityIssue,
  type CompatibilityRegistrySnapshot,
  type CompatibilityResult,
  type CompatibilitySeverity,
  compatibilityCheck,
  createExtendedProposalValidator,
  createProposalValidator,
  DEFAULT_MAX_HISTORY_MESSAGES as INTENT_DEFAULT_MAX_HISTORY_MESSAGES,
  type DryRunModelError,
  type DryRunResult,
  type DryRunSideEffects,
  detectInjection,
  dryRunProposal,
  type EntityCreateChange,
  type EntityDeleteChange,
  type EntityReference,
  type EntityRenameChange,
  type EnumOptionsChange,
  type ExtendedPhaseStatus,
  type ExtendedPhaseSummary,
  type ExtendedValidationResult,
  type ExtendedValidatorConfig,
  type ExtendedValidatorInput,
  type FieldAddChange,
  type FieldConstraintChange,
  type FieldDropChange,
  type FieldTypeChange,
  type InjectionDetectionConfig,
  type InjectionDetectionResult,
  type InjectionPattern,
  type Intent,
  type IntentAlternative,
  type IntentCatalogEntry,
  type IntentClarification,
  type IntentHistoryMessage,
  type IntentMatch,
  type IntentMultiStep,
  type IntentNoMatch,
  type IntentOntology,
  type IntentPromptOptions,
  type IntentResolutionAuditPayload,
  type IntentResolverOptions,
  type IntentSlot,
  type IntentStep,
  MAX_ALTERNATIVES as INTENT_MAX_ALTERNATIVES,
  MIN_CONFIDENCE as INTENT_MIN_CONFIDENCE,
  type OutputValidationResult,
  type OutputValidationRule,
  type OutputValidatorConfig,
  type OutputViolation,
  type OutputViolationSeverity,
  type OutputViolationType,
  type PIIPattern,
  type PIISanitizationConfig,
  type PIISanitizationResult,
  type PIIType,
  type PromptSanitizerOptions,
  type ProposalChange,
  type ProposalChangeType,
  type ProposalCustomRule,
  type ProposalRiskLevel,
  type ProposalValidationResult,
  type ProposalValidatorConfig,
  type ProposalViolation,
  type ResolveIntentDeps,
  type ResolveIntentInput,
  resolveIntent,
  type SanitizationResult,
  sanitizeAIOutput,
  sanitizePII,
  sanitizePrompt,
  sanitizeRecordForAI,
  validateAIOutput,
  validateProposal as validateAIProposal,
  validateProposalExtended,
} from "../../ai";
export { createNoopAIService } from "../../ai/ai-service";
