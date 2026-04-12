/**
 * AI Modification Rules
 *
 * Defines and enforces boundaries on what AI can modify at the entity/field level.
 * Default behavior: everything requires approval (safe by design).
 *
 * Modification levels (from most to least restrictive):
 * - read_only:  AI can only read, never modify
 * - suggest:    AI can propose changes, but always requires human approval
 * - auto_safe:  AI can auto-apply low-risk changes (e.g. non-critical fields)
 * - auto_all:   AI can auto-apply all changes (use with caution)
 */

// ── Types ────────────────────────────────────────────────────

/** How much autonomy AI has over a given entity or field */
export type AIModificationLevel = "read_only" | "suggest" | "auto_safe" | "auto_all";

/** A single rule governing AI modification access to an entity (and optionally specific fields) */
export interface AIModificationRule {
  /** Target entity name (snake_case) */
  entity: string;

  /** Optional field-level scoping. When omitted, rule applies to all fields of the entity. */
  fields?: string[];

  /** The modification level granted */
  level: AIModificationLevel;

  /** Whether human approval is required before changes take effect */
  requiresApproval: boolean;

  /** Human-readable reason for this rule (for audit trail and UI display) */
  reason: string;
}

/** Result of a canModify check */
export interface AIModificationCheckResult {
  /** Whether modification is allowed at the requested level */
  allowed: boolean;

  /** Whether human approval is required */
  requiresApproval: boolean;

  /** The effective modification level */
  effectiveLevel: AIModificationLevel;

  /** The rule that determined this result (undefined = default deny) */
  matchedRule?: AIModificationRule;

  /** Reason for the decision */
  reason: string;
}

// ── Ordering for level comparison ────────────────────────────

const LEVEL_ORDER: Record<AIModificationLevel, number> = {
  read_only: 0,
  suggest: 1,
  auto_safe: 2,
  auto_all: 3,
};

// ── Registry ─────────────────────────────────────────────────

/**
 * Registry for AI modification rules.
 *
 * Rules are matched by entity name, then optionally by field name.
 * When multiple rules match, the most specific one wins (field-level > entity-level).
 * When no rule matches, the default is deny (read_only + requiresApproval).
 */
export class AIModificationRuleRegistry {
  private readonly rules: AIModificationRule[] = [];

  /** Register a new modification rule */
  register(rule: AIModificationRule): void {
    this.rules.push(rule);
  }

  /** Register multiple rules at once */
  registerAll(rules: AIModificationRule[]): void {
    for (const rule of rules) {
      this.register(rule);
    }
  }

  /** Get all rules for a given entity */
  getRulesForEntity(entity: string): AIModificationRule[] {
    return this.rules.filter((r) => r.entity === entity);
  }

  /**
   * Check whether AI can modify a given entity/field at the requested level.
   *
   * Matching priority:
   * 1. Field-specific rule (entity + field match)
   * 2. Entity-wide rule (entity match, no fields specified)
   * 3. Default: deny (read_only, requires approval)
   */
  canModify(
    entity: string,
    field: string | undefined,
    level: AIModificationLevel,
  ): AIModificationCheckResult {
    const entityRules = this.getRulesForEntity(entity);

    // Try field-specific match first
    if (field) {
      const fieldRule = entityRules.find((r) => r.fields?.includes(field));
      if (fieldRule) {
        return this.evaluateRule(fieldRule, level);
      }
    }

    // Try entity-wide rule (no fields specified = applies to all fields)
    const entityRule = entityRules.find((r) => r.fields === undefined || r.fields.length === 0);
    if (entityRule) {
      return this.evaluateRule(entityRule, level);
    }

    // Default: deny — safe by design
    return {
      allowed: false,
      requiresApproval: true,
      effectiveLevel: "read_only",
      reason: `No AI modification rule found for entity "${entity}"${field ? `, field "${field}"` : ""}. Default: deny.`,
    };
  }

  /** Get all registered rules */
  getAllRules(): readonly AIModificationRule[] {
    return this.rules;
  }

  /** Clear all rules (useful for testing) */
  clear(): void {
    this.rules.length = 0;
  }

  // ── Private ────────────────────────────────────────────────

  private evaluateRule(
    rule: AIModificationRule,
    requestedLevel: AIModificationLevel,
  ): AIModificationCheckResult {
    const ruleLevel = LEVEL_ORDER[rule.level];
    const requested = LEVEL_ORDER[requestedLevel];

    // The requested level must not exceed what the rule grants
    const allowed = requested <= ruleLevel && rule.level !== "read_only";

    return {
      allowed,
      requiresApproval: rule.requiresApproval,
      effectiveLevel: rule.level,
      matchedRule: rule,
      reason: allowed
        ? `Allowed by rule: ${rule.reason}`
        : rule.level === "read_only"
          ? `Entity "${rule.entity}" is read-only for AI: ${rule.reason}`
          : `Requested level "${requestedLevel}" exceeds granted level "${rule.level}": ${rule.reason}`,
    };
  }
}
