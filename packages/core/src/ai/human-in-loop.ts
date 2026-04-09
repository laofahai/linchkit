/**
 * Human-in-Loop Enforcement
 *
 * Determines when AI-initiated actions require human approval before execution.
 * Two dimensions:
 * 1. Confidence-based: low AI confidence → require approval
 * 2. Risk-based: high-risk action categories → always require approval
 *
 * This complements the AIModificationRuleRegistry (entity/field-level) by adding
 * action-level and context-level gates.
 */

// ── Types ────────────────────────────────────────────────────

/** Policy defining when a specific action requires human approval */
export interface HumanInLoopPolicy {
  /** Action name pattern (exact match or glob-like with trailing '*') */
  action: string;

  /** Confidence threshold (0-1). Below this → always require approval. */
  threshold: number;

  /** Optional: specific role that must approve */
  approverRole?: string;
}

/** Risk classification for actions */
export type ActionRiskCategory = "low" | "medium" | "high" | "critical";

/** Context passed to the approval check */
export interface HumanInLoopContext {
  /** AI confidence score for this action (0-1) */
  confidence: number;

  /** Whether the actor is an AI agent */
  isAIInitiated: boolean;

  /** Optional: the entity being acted upon */
  entity?: string;

  /** Optional: number of records affected */
  affectedRecords?: number;

  /** Optional: estimated financial impact */
  financialImpact?: number;
}

/** Result of the human-in-loop check */
export interface HumanInLoopResult {
  /** Whether human approval is required */
  requiresApproval: boolean;

  /** Why approval is (or isn't) required */
  reason: string;

  /** The risk category determined for this action */
  riskCategory: ActionRiskCategory;

  /** Suggested approver role (from matching policy, if any) */
  approverRole?: string;
}

// ── Default high-risk action patterns ────────────────────────

/** Action name patterns that are always considered high-risk */
const DEFAULT_HIGH_RISK_PATTERNS: string[] = [
  "delete_*",
  "remove_*",
  "destroy_*",
  "purge_*",
  "transfer_*",
  "pay_*",
  "refund_*",
  "approve_*",
  "reject_*",
  "revoke_*",
  "grant_*",
  "escalate_*",
];

/** Action name patterns that are always considered critical-risk */
const DEFAULT_CRITICAL_RISK_PATTERNS: string[] = ["drop_*", "terminate_*", "shutdown_*"];

// ── Pattern matching ─────────────────────────────────────────

function matchesPattern(actionName: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return actionName.startsWith(pattern.slice(0, -1));
  }
  return actionName === pattern;
}

// ── Risk classification ──────────────────────────────────────

/**
 * Classify the risk level of an action based on its name and context.
 * Uses built-in pattern lists plus optional custom high-risk patterns.
 */
export function classifyActionRisk(
  action: string,
  context?: Pick<HumanInLoopContext, "affectedRecords" | "financialImpact">,
  customHighRiskPatterns?: string[],
): ActionRiskCategory {
  // Critical patterns always win
  for (const pattern of DEFAULT_CRITICAL_RISK_PATTERNS) {
    if (matchesPattern(action, pattern)) return "critical";
  }

  // High-risk patterns
  const highRiskPatterns = [...DEFAULT_HIGH_RISK_PATTERNS, ...(customHighRiskPatterns ?? [])];
  for (const pattern of highRiskPatterns) {
    if (matchesPattern(action, pattern)) return "high";
  }

  // Context-based escalation
  if (context?.financialImpact !== undefined && context.financialImpact > 10_000) {
    return "high";
  }
  if (context?.affectedRecords !== undefined && context.affectedRecords > 100) {
    return "medium";
  }

  return "low";
}

// ── Main check function ──────────────────────────────────────

/**
 * Determine if an AI-initiated action requires human approval.
 *
 * Decision logic (in order):
 * 1. Non-AI-initiated actions: no approval needed (human is already in the loop)
 * 2. Critical-risk actions: always require approval
 * 3. High-risk actions: always require approval
 * 4. Matching policy with confidence below threshold: require approval
 * 5. No matching policy but confidence < default threshold (0.8): require approval
 * 6. Otherwise: no approval needed
 */
export function requiresHumanApproval(
  action: string,
  context: HumanInLoopContext,
  options?: {
    policies?: HumanInLoopPolicy[];
    customHighRiskPatterns?: string[];
    defaultThreshold?: number;
  },
): HumanInLoopResult {
  const policies = options?.policies ?? [];
  const defaultThreshold = options?.defaultThreshold ?? 0.8;
  const riskCategory = classifyActionRisk(action, context, options?.customHighRiskPatterns);

  // Non-AI actions don't need AI-specific approval
  if (!context.isAIInitiated) {
    return {
      requiresApproval: false,
      reason: "Action is human-initiated; no AI approval gate needed.",
      riskCategory,
    };
  }

  // Critical and high-risk: always require approval
  if (riskCategory === "critical") {
    return {
      requiresApproval: true,
      reason: `Action "${action}" is classified as critical-risk. Human approval is always required.`,
      riskCategory,
    };
  }

  if (riskCategory === "high") {
    return {
      requiresApproval: true,
      reason: `Action "${action}" is classified as high-risk. Human approval is always required.`,
      riskCategory,
    };
  }

  // Check explicit policies
  const matchingPolicy = policies.find((p) => matchesPattern(action, p.action));
  if (matchingPolicy) {
    const belowThreshold = context.confidence < matchingPolicy.threshold;
    return {
      requiresApproval: belowThreshold,
      reason: belowThreshold
        ? `AI confidence ${context.confidence.toFixed(2)} is below policy threshold ${matchingPolicy.threshold.toFixed(2)} for "${action}".`
        : `AI confidence ${context.confidence.toFixed(2)} meets policy threshold ${matchingPolicy.threshold.toFixed(2)} for "${action}".`,
      riskCategory,
      approverRole: matchingPolicy.approverRole,
    };
  }

  // Default threshold check
  const belowDefault = context.confidence < defaultThreshold;
  return {
    requiresApproval: belowDefault,
    reason: belowDefault
      ? `AI confidence ${context.confidence.toFixed(2)} is below default threshold ${defaultThreshold.toFixed(2)}.`
      : `AI confidence ${context.confidence.toFixed(2)} meets default threshold ${defaultThreshold.toFixed(2)}. No approval needed.`,
    riskCategory,
  };
}
