/**
 * AI Proposal Validator
 *
 * Enforces security constraints on AI-generated Proposals before they can
 * be submitted for approval or auto-applied.
 *
 * See spec 27_ai_security.md §1.2 (Malicious Proposals) and §3 (forbiddenChanges):
 * - Certain changes are forbidden for AI (delete_rule, modify_permission, delete_schema)
 * - High-risk changes require human approval
 * - All proposals are validated against security rules
 */

// ── Types ─────────────────────────────────────────────────────

/** Categories of proposal changes that may be restricted */
export type ProposalChangeType =
  | "create_schema"
  | "modify_schema"
  | "delete_schema"
  | "create_rule"
  | "modify_rule"
  | "delete_rule"
  | "create_action"
  | "modify_action"
  | "delete_action"
  | "modify_permission"
  | "delete_permission"
  | "modify_state"
  | "create_flow"
  | "modify_flow"
  | "delete_flow"
  | "modify_config"
  | "data_migration"
  | "bulk_data_change";

/** Risk classification for a proposal */
export type ProposalRiskLevel = "low" | "medium" | "high" | "critical";

/** A single change within a proposal */
export interface ProposalChange {
  /** Type of change */
  type: ProposalChangeType;

  /** Target entity name (schema name, rule name, etc.) */
  target: string;

  /** Description of the change */
  description?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Result of proposal validation */
export interface ProposalValidationResult {
  /** Whether the proposal is valid and allowed */
  valid: boolean;

  /** Overall risk level (highest among all changes) */
  riskLevel: ProposalRiskLevel;

  /** Whether human approval is required */
  requiresHumanApproval: boolean;

  /** List of violations (if any) */
  violations: ProposalViolation[];

  /** Warnings (non-blocking) */
  warnings: string[];
}

/** A single validation violation */
export interface ProposalViolation {
  /** The change that triggered the violation */
  change: ProposalChange;

  /** Rule name that was violated */
  ruleName: string;

  /** Human-readable reason */
  reason: string;
}

/** Configuration for proposal validation */
export interface ProposalValidatorConfig {
  /** Change types that AI is forbidden from making (always blocked) */
  forbiddenChanges?: ProposalChangeType[];

  /** Change types that require human approval (never auto-applied) */
  requireApprovalFor?: ProposalChangeType[];

  /** Maximum number of changes in a single proposal (default: 50) */
  maxChangesPerProposal?: number;

  /** Whether all proposals require human approval (default: true for M2) */
  requireHumanApprovalForAll?: boolean;

  /** Custom validation rules */
  customRules?: ProposalCustomRule[];

  /** Sensitive entity names that require extra scrutiny */
  sensitiveEntities?: string[];
}

/** A custom validation rule for proposals */
export interface ProposalCustomRule {
  /** Rule name */
  name: string;

  /** Predicate — returns a violation reason string if the change is invalid, or undefined if valid */
  validate: (change: ProposalChange) => string | undefined;
}

// ── Default Configuration ─────────────────────────────────────

/** Default forbidden changes per spec 27 §3 */
const DEFAULT_FORBIDDEN_CHANGES: ProposalChangeType[] = [
  "delete_rule",
  "modify_permission",
  "delete_permission",
  "delete_schema",
];

/** Change types that always require human approval */
const DEFAULT_REQUIRE_APPROVAL: ProposalChangeType[] = [
  "create_schema",
  "modify_schema",
  "create_rule",
  "modify_rule",
  "create_action",
  "modify_action",
  "delete_action",
  "modify_state",
  "create_flow",
  "modify_flow",
  "delete_flow",
  "modify_config",
  "data_migration",
  "bulk_data_change",
];

/** Risk level mapping for change types */
const CHANGE_RISK_LEVELS: Record<ProposalChangeType, ProposalRiskLevel> = {
  create_schema: "medium",
  modify_schema: "high",
  delete_schema: "critical",
  create_rule: "medium",
  modify_rule: "high",
  delete_rule: "critical",
  create_action: "medium",
  modify_action: "high",
  delete_action: "critical",
  modify_permission: "critical",
  delete_permission: "critical",
  modify_state: "high",
  create_flow: "medium",
  modify_flow: "high",
  delete_flow: "critical",
  modify_config: "high",
  data_migration: "high",
  bulk_data_change: "high",
};

// ── Risk Level Ordering ──────────────────────────────────────

const RISK_ORDER: Record<ProposalRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ── Proposal Validator ────────────────────────────────────────

/**
 * Validate an AI-generated proposal against security rules.
 *
 * Checks:
 * 1. Forbidden changes — always blocked
 * 2. Change count limits — prevents excessive scope
 * 3. Risk level assessment — based on change types
 * 4. Human approval requirements — based on change types and config
 * 5. Sensitive entity checks — extra scrutiny for named entities
 * 6. Custom validation rules
 */
export function validateProposal(
  changes: ProposalChange[],
  config?: ProposalValidatorConfig,
): ProposalValidationResult {
  const forbiddenChanges = config?.forbiddenChanges ?? DEFAULT_FORBIDDEN_CHANGES;
  const requireApprovalFor = config?.requireApprovalFor ?? DEFAULT_REQUIRE_APPROVAL;
  const maxChanges = config?.maxChangesPerProposal ?? 50;
  const requireApprovalForAll = config?.requireHumanApprovalForAll ?? true;
  const sensitiveEntities = new Set(config?.sensitiveEntities ?? []);
  const customRules = config?.customRules ?? [];

  const violations: ProposalViolation[] = [];
  const warnings: string[] = [];
  let highestRisk: ProposalRiskLevel = "low";
  let requiresHumanApproval = requireApprovalForAll;

  // Check change count
  if (changes.length > maxChanges) {
    violations.push({
      change: { type: "bulk_data_change", target: "*" },
      ruleName: "max_changes_exceeded",
      reason: `Proposal contains ${changes.length} changes, exceeding maximum of ${maxChanges}`,
    });
  }

  if (changes.length === 0) {
    return {
      valid: true,
      riskLevel: "low",
      requiresHumanApproval: false,
      violations: [],
      warnings: ["Empty proposal — no changes to validate"],
    };
  }

  for (const change of changes) {
    // 1. Check forbidden changes
    if (forbiddenChanges.includes(change.type)) {
      violations.push({
        change,
        ruleName: "forbidden_change",
        reason: `AI is forbidden from making "${change.type}" changes (target: ${change.target})`,
      });
    }

    // 2. Assess risk level
    const changeRisk = CHANGE_RISK_LEVELS[change.type] ?? "medium";
    if (RISK_ORDER[changeRisk] > RISK_ORDER[highestRisk]) {
      highestRisk = changeRisk;
    }

    // 3. Check human approval requirements
    if (requireApprovalFor.includes(change.type)) {
      requiresHumanApproval = true;
    }

    // 4. Sensitive entity check
    if (sensitiveEntities.has(change.target)) {
      warnings.push(
        `Change to sensitive entity "${change.target}" (${change.type}) — requires extra review`,
      );
      // Sensitive entities always bump risk to at least high
      if (RISK_ORDER[highestRisk] < RISK_ORDER.high) {
        highestRisk = "high";
      }
      requiresHumanApproval = true;
    }

    // 5. Custom rules
    for (const rule of customRules) {
      const violation = rule.validate(change);
      if (violation) {
        violations.push({
          change,
          ruleName: rule.name,
          reason: violation,
        });
      }
    }
  }

  // Warn if many changes affect the same entity
  const entityCounts = new Map<string, number>();
  for (const change of changes) {
    entityCounts.set(change.target, (entityCounts.get(change.target) ?? 0) + 1);
  }
  for (const [entity, count] of entityCounts) {
    if (count > 5) {
      warnings.push(
        `Entity "${entity}" has ${count} changes in a single proposal — review carefully`,
      );
    }
  }

  return {
    valid: violations.length === 0,
    riskLevel: highestRisk,
    requiresHumanApproval,
    violations,
    warnings,
  };
}

/**
 * Create a reusable proposal validator with pre-configured settings.
 *
 * Returns a bound validateProposal function — useful when the same
 * config is used across multiple validation calls.
 */
export function createProposalValidator(config: ProposalValidatorConfig) {
  return {
    validate: (changes: ProposalChange[]) => validateProposal(changes, config),
    config,
  };
}
