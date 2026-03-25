/**
 * AI Policy type definitions
 *
 * Defines constraints for AI operations to enforce the boundary between
 * deterministic Rule Engine execution and probabilistic AI reasoning.
 * See spec 22_ai_rule_boundary.md.
 *
 * Core principles:
 * - AI should not make runtime business decisions (use Rule Engine)
 * - AI output affecting production must go through Proposal flow
 * - Rate limits, cost budgets, and action allowlists protect the system
 */

// ── AI Policy ─────────────────────────────────────────────

/** Defines constraints for AI operations within a scope (global, tenant, or user) */
export interface AIPolicy {
  /** Unique policy name */
  name: string;

  /** Human-readable description */
  description?: string;

  /** Rate limiting configuration */
  rateLimits?: AIRateLimits;

  /** Action access control for AI-initiated operations */
  actionAccess?: AIActionAccess;

  /** Cost budget constraints */
  budget?: AIBudgetConfig;

  /** Content filtering rules */
  contentFilters?: AIContentFilter[];

  /** Whether AI can directly modify production data (default: false) */
  allowDirectDataModification?: boolean;

  /** Whether AI output must go through Proposal flow (default: true) */
  requireProposalForChanges?: boolean;

  /** Maximum tokens per single request (overrides AIServiceConfig.limits) */
  maxTokensPerRequest?: number;

  /** Maximum concurrent AI calls (default: 5) */
  maxConcurrentCalls?: number;
}

// ── Rate Limits ───────────────────────────────────────────

export interface AIRateLimits {
  /** Max requests per minute per tenant */
  maxRequestsPerMinute?: number;

  /** Max requests per hour per tenant */
  maxRequestsPerHour?: number;

  /** Max requests per day per tenant */
  maxRequestsPerDay?: number;

  /** Max requests per minute per user */
  maxRequestsPerMinutePerUser?: number;

  /** Max requests per action type per minute */
  maxRequestsPerMinutePerAction?: number;
}

// ── Action Access Control ─────────────────────────────────

export interface AIActionAccess {
  /** Access mode: 'allowlist' only permits listed actions, 'denylist' blocks listed actions */
  mode: "allowlist" | "denylist";

  /** Action names for the access list */
  actions: string[];

  /** Actions that AI can read/query but not execute */
  readOnlyActions?: string[];
}

// ── Budget Configuration ──────────────────────────────────

export interface AIBudgetConfig {
  /** Maximum cost in USD per day */
  maxCostPerDay?: number;

  /** Maximum cost in USD per hour */
  maxCostPerHour?: number;

  /** Maximum cost in USD per single request */
  maxCostPerRequest?: number;

  /** Maximum total tokens per day */
  maxTokensPerDay?: number;

  /** Alert threshold as percentage of daily budget (0-1, default: 0.8) */
  alertThreshold?: number;
}

// ── Content Filters ───────────────────────────────────────

export interface AIContentFilter {
  /** Filter name for logging */
  name: string;

  /** Pattern type */
  type: "regex" | "keyword";

  /** Pattern to match against AI input/output */
  pattern: string;

  /** What to do when filter matches */
  action: "block" | "warn" | "redact";

  /** Apply to input, output, or both (default: "both") */
  scope?: "input" | "output" | "both";
}

// ── Usage Tracking ────────────────────────────────────────

/** Records a single AI call for auditability */
export interface AIUsageRecord {
  /** Unique record ID */
  id: string;

  /** Timestamp of the call */
  timestamp: Date;

  /** Tenant that initiated the call */
  tenantId?: string;

  /** User/actor that initiated the call */
  actorId?: string;

  /** Source: flow step, MCP tool, or direct API */
  source: "flow" | "mcp" | "api";

  /** Action name if AI was used in context of an action */
  actionName?: string;

  /** AI model used */
  model: string;

  /** AI provider used */
  provider: string;

  /** Input tokens consumed */
  inputTokens: number;

  /** Output tokens consumed */
  outputTokens: number;

  /** Total tokens consumed */
  totalTokens: number;

  /** Estimated cost in USD */
  cost?: number;

  /** Duration in milliseconds */
  duration: number;

  /** Whether the call was allowed or blocked */
  status: "allowed" | "blocked" | "budget_exceeded" | "rate_limited" | "filtered";

  /** Reason for blocking (if status is not 'allowed') */
  blockReason?: string;

  /** Policy name that was applied */
  policyName?: string;
}

// ── Budget Tracking ───────────────────────────────────────

/** Tracks accumulated AI usage against budget constraints */
export interface AIBudget {
  /** Tenant ID (undefined = global) */
  tenantId?: string;

  /** Total cost accumulated today (USD) */
  costToday: number;

  /** Total cost accumulated this hour (USD) */
  costThisHour: number;

  /** Total tokens used today */
  tokensToday: number;

  /** Number of requests today */
  requestsToday: number;

  /** Number of requests this hour */
  requestsThisHour: number;

  /** Number of requests this minute */
  requestsThisMinute: number;

  /** Timestamp when daily counters were last reset */
  dayResetAt: Date;

  /** Timestamp when hourly counters were last reset */
  hourResetAt: Date;

  /** Timestamp when minute counters were last reset */
  minuteResetAt: Date;
}

// ── Boundary Check Result ─────────────────────────────────

/** Result of an AI boundary check before executing an AI call */
export interface AIBoundaryCheckResult {
  /** Whether the AI call is allowed */
  allowed: boolean;

  /** Reason for denial (if not allowed) */
  reason?: string;

  /** Specific violation type */
  violation?:
    | "rate_limit"
    | "budget_exceeded"
    | "action_denied"
    | "content_filtered"
    | "policy_denied";

  /** The policy that caused the denial */
  policyName?: string;

  /** Warnings (non-blocking) — e.g. approaching budget threshold */
  warnings?: string[];
}

// ── AI Call Request (for boundary checking) ───────────────

/** Describes an intended AI call for pre-execution boundary checking */
export interface AICallRequest {
  /** Source of the AI call */
  source: "flow" | "mcp" | "api";

  /** Tenant ID */
  tenantId?: string;

  /** Actor/user ID */
  actorId?: string;

  /** Action being executed (if applicable) */
  actionName?: string;

  /** Estimated input tokens (if known) */
  estimatedTokens?: number;

  /** Whether this call would modify data */
  isDataModification?: boolean;

  /** The prompt content (for content filtering) */
  promptContent?: string;
}
