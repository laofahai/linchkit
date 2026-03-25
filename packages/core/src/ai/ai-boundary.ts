/**
 * AI Boundary Engine
 *
 * Enforces safety constraints on AI operations based on the principles in
 * spec 22_ai_rule_boundary.md:
 * - AI should not make runtime business decisions
 * - AI output affecting production must go through Proposal flow
 * - Rate limits, cost budgets, and action allowlists protect the system
 *
 * The boundary engine wraps AI service calls, checking policies before
 * execution and recording usage for auditability.
 */

import type { AICompletionOptions, AICompletionResult, AIService } from "../types/ai";
import type { Logger } from "../types/logger";
import type {
  AIBoundaryCheckResult,
  AIBudget,
  AICallRequest,
  AIContentFilter,
  AIPolicy,
  AIUsageRecord,
} from "./ai-policy";

// ── AIBoundary Options ────────────────────────────────────

export interface AIBoundaryOptions {
  /** The underlying AI service to wrap */
  aiService: AIService;

  /** Default policy applied to all AI calls */
  defaultPolicy?: AIPolicy;

  /** Tenant-specific policy overrides */
  tenantPolicies?: Record<string, AIPolicy>;

  /** Logger for audit trail */
  logger?: Logger;

  /** Callback when a usage record is created (for persistence) */
  onUsageRecord?: (record: AIUsageRecord) => void;

  /** Callback when budget alert threshold is reached */
  onBudgetAlert?: (tenantId: string | undefined, budget: AIBudget, threshold: number) => void;
}

// ── Default Policy ────────────────────────────────────────

const DEFAULT_POLICY: AIPolicy = {
  name: "default",
  description: "Default AI boundary policy",
  rateLimits: {
    maxRequestsPerMinute: 60,
    maxRequestsPerHour: 500,
    maxRequestsPerDay: 5000,
  },
  budget: {
    maxCostPerDay: 100,
    maxCostPerRequest: 5,
    alertThreshold: 0.8,
  },
  allowDirectDataModification: false,
  requireProposalForChanges: true,
  maxConcurrentCalls: 5,
};

// ── AIBoundary Engine ─────────────────────────────────────

export class AIBoundary {
  private readonly aiService: AIService;
  private readonly defaultPolicy: AIPolicy;
  private readonly tenantPolicies: Map<string, AIPolicy>;
  private readonly logger?: Logger;
  private readonly onUsageRecord?: (record: AIUsageRecord) => void;
  private readonly onBudgetAlert?: (
    tenantId: string | undefined,
    budget: AIBudget,
    threshold: number,
  ) => void;

  /** In-memory budget trackers keyed by tenantId (undefined key = global) */
  private readonly budgets: Map<string, AIBudget> = new Map();

  /** Usage log (in-memory, capped to prevent unbounded growth) */
  private readonly usageLog: AIUsageRecord[] = [];

  /** Active concurrent call count per tenant */
  private readonly activeCalls: Map<string, number> = new Map();

  /** Regex cache for content filter patterns */
  private readonly regexCache: Map<string, RegExp> = new Map();

  /** Maximum number of usage log entries before trimming */
  private static readonly MAX_USAGE_LOG = 10_000;

  /** Counter for generating unique record IDs */
  private recordCounter = 0;

  constructor(options: AIBoundaryOptions) {
    this.aiService = options.aiService;
    this.defaultPolicy = options.defaultPolicy ?? DEFAULT_POLICY;
    this.tenantPolicies = new Map(Object.entries(options.tenantPolicies ?? {}));
    this.logger = options.logger;
    this.onUsageRecord = options.onUsageRecord;
    this.onBudgetAlert = options.onBudgetAlert;
  }

  // ── Policy Management ─────────────────────────────────

  /** Register or update a tenant-specific policy */
  setTenantPolicy(tenantId: string, policy: AIPolicy): void {
    this.tenantPolicies.set(tenantId, policy);
    this.logger?.info("AI boundary: tenant policy updated", { tenantId, policyName: policy.name });
  }

  /** Remove a tenant-specific policy (falls back to default) */
  removeTenantPolicy(tenantId: string): void {
    this.tenantPolicies.delete(tenantId);
  }

  /** Get the effective policy for a tenant */
  getEffectivePolicy(tenantId?: string): AIPolicy {
    if (tenantId && this.tenantPolicies.has(tenantId)) {
      // biome-ignore lint/style/noNonNullAssertion: existence checked by has() above
      return this.tenantPolicies.get(tenantId)!;
    }
    return this.defaultPolicy;
  }

  // ── Boundary Check ────────────────────────────────────

  /** Check if an AI call is allowed under the current policy */
  check(request: AICallRequest): AIBoundaryCheckResult {
    const policy = this.getEffectivePolicy(request.tenantId);
    const warnings: string[] = [];

    // 1. Check data modification restriction
    if (request.isDataModification && !policy.allowDirectDataModification) {
      return {
        allowed: false,
        reason: "AI is not allowed to directly modify production data. Use Proposal flow instead.",
        violation: "policy_denied",
        policyName: policy.name,
      };
    }

    // 2. Check action access control
    if (request.actionName && policy.actionAccess) {
      const accessResult = this.checkActionAccess(request.actionName, policy);
      if (!accessResult.allowed) {
        return accessResult;
      }
    }

    // 3. Check rate limits
    if (policy.rateLimits) {
      const rateLimitResult = this.checkRateLimits(request, policy);
      if (!rateLimitResult.allowed) {
        return rateLimitResult;
      }
    }

    // 4. Check budget
    if (policy.budget) {
      const budgetResult = this.checkBudget(request, policy, warnings);
      if (!budgetResult.allowed) {
        return budgetResult;
      }
    }

    // 5. Check concurrent call limit
    const concurrentLimit = policy.maxConcurrentCalls ?? 5;
    const tenantKey = request.tenantId ?? "__global__";
    const currentActive = this.activeCalls.get(tenantKey) ?? 0;
    if (currentActive >= concurrentLimit) {
      return {
        allowed: false,
        reason: `Concurrent AI call limit reached (${concurrentLimit}). Wait for active calls to complete.`,
        violation: "rate_limit",
        policyName: policy.name,
      };
    }

    // 6. Check content filters
    if (request.promptContent && policy.contentFilters) {
      const filterResult = this.checkContentFilters(
        request.promptContent,
        policy.contentFilters,
        "input",
      );
      if (!filterResult.allowed) {
        return { ...filterResult, policyName: policy.name };
      }
      if (filterResult.warnings) {
        warnings.push(...filterResult.warnings);
      }
    }

    return {
      allowed: true,
      policyName: policy.name,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ── Wrapped AI Execution ──────────────────────────────

  /**
   * Execute an AI completion with boundary enforcement.
   * Checks policy before execution, records usage after.
   */
  async execute(options: AICompletionOptions, request: AICallRequest): Promise<AICompletionResult> {
    // Pre-flight check
    const checkResult = this.check(request);

    if (!checkResult.allowed) {
      const record = this.createUsageRecord(request, {
        status:
          checkResult.violation === "rate_limit"
            ? "rate_limited"
            : checkResult.violation === "budget_exceeded"
              ? "budget_exceeded"
              : checkResult.violation === "content_filtered"
                ? "filtered"
                : "blocked",
        blockReason: checkResult.reason,
        policyName: checkResult.policyName,
      });
      this.recordUsage(record);

      throw new AIBoundaryError(
        checkResult.reason ?? "AI call blocked by boundary policy",
        checkResult.violation ?? "policy_denied",
        checkResult.policyName,
      );
    }

    // Log warnings
    if (checkResult.warnings) {
      for (const warning of checkResult.warnings) {
        this.logger?.warn("AI boundary warning", { warning, tenantId: request.tenantId });
      }
    }

    // Optimistic increment: count the request NOW to prevent TOCTOU races
    // where concurrent check() calls both pass before either increments.
    const budget = this.getBudget(request.tenantId);
    this.refreshBudgetWindows(budget);
    budget.requestsThisMinute++;
    budget.requestsThisHour++;
    budget.requestsToday++;

    // Track concurrent calls
    const tenantKey = request.tenantId ?? "__global__";
    this.activeCalls.set(tenantKey, (this.activeCalls.get(tenantKey) ?? 0) + 1);

    const startTime = Date.now();
    try {
      const result = await this.aiService.complete(options);

      // Check output content filters
      const policy = this.getEffectivePolicy(request.tenantId);
      if (policy.contentFilters && result.content) {
        const filterResult = this.checkContentFilters(
          result.content,
          policy.contentFilters,
          "output",
        );
        if (!filterResult.allowed) {
          const record = this.createUsageRecord(request, {
            status: "filtered",
            blockReason: filterResult.reason,
            policyName: policy.name,
            tokens: result.usage,
            duration: Date.now() - startTime,
            model: result.model,
            provider: result.provider,
          });
          this.recordUsage(record);

          throw new AIBoundaryError(
            filterResult.reason ?? "AI output blocked by content filter",
            "content_filtered",
            policy.name,
          );
        }
      }

      // Record successful usage
      const record = this.createUsageRecord(request, {
        status: "allowed",
        policyName: policy.name,
        tokens: result.usage,
        duration: Date.now() - startTime,
        model: result.model,
        provider: result.provider,
        cost: result.usage.cost,
      });
      this.recordUsage(record);

      // Update budget trackers
      this.updateBudget(request.tenantId, {
        cost: result.usage.cost ?? 0,
        tokens: result.usage.totalTokens,
      });

      return result;
    } finally {
      // Decrement concurrent calls
      const current = this.activeCalls.get(tenantKey) ?? 1;
      if (current <= 1) {
        this.activeCalls.delete(tenantKey);
      } else {
        this.activeCalls.set(tenantKey, current - 1);
      }
    }
  }

  // ── Usage & Budget Queries ────────────────────────────

  /** Get current budget status for a tenant (or global) */
  getBudget(tenantId?: string): AIBudget {
    const key = tenantId ?? "__global__";
    return this.getOrCreateBudget(key);
  }

  /** Get usage records (most recent first), optionally filtered */
  getUsageRecords(options?: {
    tenantId?: string;
    source?: AICallRequest["source"];
    limit?: number;
  }): AIUsageRecord[] {
    let records = [...this.usageLog];

    if (options?.tenantId) {
      records = records.filter((r) => r.tenantId === options.tenantId);
    }
    if (options?.source) {
      records = records.filter((r) => r.source === options.source);
    }

    records.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (options?.limit) {
      records = records.slice(0, options.limit);
    }

    return records;
  }

  /** Reset budget counters for a tenant (or global). Useful for testing or manual reset. */
  resetBudget(tenantId?: string): void {
    const key = tenantId ?? "__global__";
    this.budgets.delete(key);
  }

  // ── Private: Action Access ────────────────────────────

  private checkActionAccess(actionName: string, policy: AIPolicy): AIBoundaryCheckResult {
    // biome-ignore lint/style/noNonNullAssertion: caller guarantees actionAccess is set
    const access = policy.actionAccess!;

    if (access.mode === "allowlist") {
      if (!access.actions.includes(actionName)) {
        return {
          allowed: false,
          reason: `Action "${actionName}" is not in the AI allowlist`,
          violation: "action_denied",
          policyName: policy.name,
        };
      }
    } else {
      // denylist mode
      if (access.actions.includes(actionName)) {
        return {
          allowed: false,
          reason: `Action "${actionName}" is blocked by AI denylist`,
          violation: "action_denied",
          policyName: policy.name,
        };
      }
    }

    return { allowed: true };
  }

  // ── Private: Rate Limits ──────────────────────────────

  private checkRateLimits(request: AICallRequest, policy: AIPolicy): AIBoundaryCheckResult {
    // biome-ignore lint/style/noNonNullAssertion: caller guarantees rateLimits is set
    const limits = policy.rateLimits!;
    const budget = this.getBudget(request.tenantId);

    // Ensure time windows are current
    this.refreshBudgetWindows(budget);

    if (
      limits.maxRequestsPerMinute != null &&
      budget.requestsThisMinute >= limits.maxRequestsPerMinute
    ) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${limits.maxRequestsPerMinute} requests per minute`,
        violation: "rate_limit",
        policyName: policy.name,
      };
    }

    if (limits.maxRequestsPerHour != null && budget.requestsThisHour >= limits.maxRequestsPerHour) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${limits.maxRequestsPerHour} requests per hour`,
        violation: "rate_limit",
        policyName: policy.name,
      };
    }

    if (limits.maxRequestsPerDay != null && budget.requestsToday >= limits.maxRequestsPerDay) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${limits.maxRequestsPerDay} requests per day`,
        violation: "rate_limit",
        policyName: policy.name,
      };
    }

    return { allowed: true };
  }

  // ── Private: Budget ───────────────────────────────────

  private checkBudget(
    request: AICallRequest,
    policy: AIPolicy,
    warnings: string[],
  ): AIBoundaryCheckResult {
    // biome-ignore lint/style/noNonNullAssertion: caller guarantees budget is set
    const budgetConfig = policy.budget!;
    const budget = this.getBudget(request.tenantId);

    // Ensure time windows are current
    this.refreshBudgetWindows(budget);

    // Check daily cost limit
    if (budgetConfig.maxCostPerDay != null && budget.costToday >= budgetConfig.maxCostPerDay) {
      return {
        allowed: false,
        reason: `Daily AI budget exceeded: $${budget.costToday.toFixed(2)} / $${budgetConfig.maxCostPerDay.toFixed(2)}`,
        violation: "budget_exceeded",
        policyName: policy.name,
      };
    }

    // Check hourly cost limit
    if (budgetConfig.maxCostPerHour != null && budget.costThisHour >= budgetConfig.maxCostPerHour) {
      return {
        allowed: false,
        reason: `Hourly AI budget exceeded: $${budget.costThisHour.toFixed(2)} / $${budgetConfig.maxCostPerHour.toFixed(2)}`,
        violation: "budget_exceeded",
        policyName: policy.name,
      };
    }

    // Check daily token limit
    if (
      budgetConfig.maxTokensPerDay != null &&
      budget.tokensToday >= budgetConfig.maxTokensPerDay
    ) {
      return {
        allowed: false,
        reason: `Daily token limit exceeded: ${budget.tokensToday} / ${budgetConfig.maxTokensPerDay}`,
        violation: "budget_exceeded",
        policyName: policy.name,
      };
    }

    // Check alert threshold
    if (budgetConfig.maxCostPerDay && budgetConfig.alertThreshold) {
      const threshold = budgetConfig.maxCostPerDay * budgetConfig.alertThreshold;
      if (budget.costToday >= threshold) {
        const pct = Math.round((budget.costToday / budgetConfig.maxCostPerDay) * 100);
        const msg = `AI budget alert: ${pct}% of daily budget used ($${budget.costToday.toFixed(2)} / $${budgetConfig.maxCostPerDay.toFixed(2)})`;
        warnings.push(msg);
        this.onBudgetAlert?.(request.tenantId, budget, budgetConfig.alertThreshold);
      }
    }

    return { allowed: true };
  }

  // ── Private: Content Filters ──────────────────────────

  private checkContentFilters(
    content: string,
    filters: AIContentFilter[],
    direction: "input" | "output",
  ): AIBoundaryCheckResult {
    const warnings: string[] = [];

    for (const filter of filters) {
      // Check scope
      const scope = filter.scope ?? "both";
      if (scope !== "both" && scope !== direction) {
        continue;
      }

      let matches = false;

      if (filter.type === "regex") {
        try {
          let regex = this.regexCache.get(filter.pattern);
          if (!regex) {
            regex = new RegExp(filter.pattern, "i");
            this.regexCache.set(filter.pattern, regex);
          }
          matches = regex.test(content);
        } catch {
          this.logger?.warn("AI boundary: invalid regex in content filter", {
            filterName: filter.name,
            pattern: filter.pattern,
          });
          continue;
        }
      } else {
        // keyword match
        matches = content.toLowerCase().includes(filter.pattern.toLowerCase());
      }

      if (matches) {
        if (filter.action === "block") {
          return {
            allowed: false,
            reason: `Content filter "${filter.name}" blocked ${direction}: matched pattern "${filter.pattern}"`,
            violation: "content_filtered",
          };
        }
        if (filter.action === "warn") {
          warnings.push(
            `Content filter "${filter.name}" warning on ${direction}: matched pattern "${filter.pattern}"`,
          );
        }
        // 'redact' action: we log a warning but allow — actual redaction is caller's responsibility
        if (filter.action === "redact") {
          warnings.push(`Content filter "${filter.name}" flagged ${direction} for redaction`);
        }
      }
    }

    return {
      allowed: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ── Private: Budget Tracking ──────────────────────────

  private getOrCreateBudget(key: string): AIBudget {
    if (!this.budgets.has(key)) {
      const now = new Date();
      this.budgets.set(key, {
        tenantId: key === "__global__" ? undefined : key,
        costToday: 0,
        costThisHour: 0,
        tokensToday: 0,
        requestsToday: 0,
        requestsThisHour: 0,
        requestsThisMinute: 0,
        dayResetAt: startOfDay(now),
        hourResetAt: startOfHour(now),
        minuteResetAt: startOfMinute(now),
      });
    }
    // biome-ignore lint/style/noNonNullAssertion: guaranteed to exist after set above
    return this.budgets.get(key)!;
  }

  private refreshBudgetWindows(budget: AIBudget): void {
    const now = new Date();

    // Reset daily counters
    const dayStart = startOfDay(now);
    if (budget.dayResetAt.getTime() < dayStart.getTime()) {
      budget.costToday = 0;
      budget.tokensToday = 0;
      budget.requestsToday = 0;
      budget.dayResetAt = dayStart;
    }

    // Reset hourly counters
    const hourStart = startOfHour(now);
    if (budget.hourResetAt.getTime() < hourStart.getTime()) {
      budget.costThisHour = 0;
      budget.requestsThisHour = 0;
      budget.hourResetAt = hourStart;
    }

    // Reset minute counters
    const minuteStart = startOfMinute(now);
    if (budget.minuteResetAt.getTime() < minuteStart.getTime()) {
      budget.requestsThisMinute = 0;
      budget.minuteResetAt = minuteStart;
    }
  }

  private updateBudget(
    tenantId: string | undefined,
    usage: { cost: number; tokens: number },
  ): void {
    const key = tenantId ?? "__global__";
    const budget = this.getOrCreateBudget(key);
    this.refreshBudgetWindows(budget);

    budget.costToday += usage.cost;
    budget.costThisHour += usage.cost;
    budget.tokensToday += usage.tokens;
    // Note: request counts are incremented optimistically in execute()
    // to prevent TOCTOU race conditions. Only cost/token tracking here.
  }

  // ── Private: Usage Recording ──────────────────────────

  private createUsageRecord(
    request: AICallRequest,
    result: {
      status: AIUsageRecord["status"];
      blockReason?: string;
      policyName?: string;
      tokens?: { inputTokens: number; outputTokens: number; totalTokens: number };
      duration?: number;
      model?: string;
      provider?: string;
      cost?: number;
    },
  ): AIUsageRecord {
    this.recordCounter += 1;
    return {
      id: `ai-usage-${Date.now()}-${this.recordCounter}`,
      timestamp: new Date(),
      tenantId: request.tenantId,
      actorId: request.actorId,
      source: request.source,
      actionName: request.actionName,
      model: result.model ?? "unknown",
      provider: result.provider ?? "unknown",
      inputTokens: result.tokens?.inputTokens ?? 0,
      outputTokens: result.tokens?.outputTokens ?? 0,
      totalTokens: result.tokens?.totalTokens ?? 0,
      cost: result.cost,
      duration: result.duration ?? 0,
      status: result.status,
      blockReason: result.blockReason,
      policyName: result.policyName,
    };
  }

  private recordUsage(record: AIUsageRecord): void {
    if (this.usageLog.length >= AIBoundary.MAX_USAGE_LOG) {
      this.usageLog.splice(0, this.usageLog.length >> 1);
    }
    this.usageLog.push(record);
    this.onUsageRecord?.(record);

    this.logger?.info("AI boundary: usage recorded", {
      id: record.id,
      status: record.status,
      source: record.source,
      tenantId: record.tenantId,
      totalTokens: record.totalTokens,
      cost: record.cost,
      blockReason: record.blockReason,
    });
  }
}

// ── AIBoundaryError ─────────────────────────────────────

/** Error thrown when an AI call is blocked by boundary policy */
export class AIBoundaryError extends Error {
  readonly violation: string;
  readonly policyName?: string;

  constructor(message: string, violation: string, policyName?: string) {
    super(message);
    this.name = "AIBoundaryError";
    this.violation = violation;
    this.policyName = policyName;
  }
}

// ── Time utilities ──────────────────────────────────────

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfHour(date: Date): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

function startOfMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}
