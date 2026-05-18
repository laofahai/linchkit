/**
 * AI Usage Meter
 *
 * Pluggable storage for per-call AI usage records, plus a quota
 * checker that aggregates today's consumption against a
 * {@link UsageQuotaPolicy}.
 *
 * Calendar-day windows are computed in UTC so quotas reset
 * deterministically regardless of caller timezone — the same call at
 * 23:59:59Z and 00:00:00Z lands in different buckets.
 */

import type { QuotaCheckResult, UsageMeterEntry, UsageQuotaPolicy } from "./byok-types";

// ── Interface ───────────────────────────────────────────────

/** Parameters for {@link UsageMeter.aggregate}. */
export interface AggregateUsageParams {
  tenantId: string;
  /** Inclusive lower bound (ISO-8601). */
  since: string;
  /** Exclusive upper bound (ISO-8601). */
  until: string;
}

/** Aggregate of usage records over a time window. */
export interface UsageAggregate {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

/** Parameters for {@link UsageMeter.checkQuota}. */
export interface CheckQuotaParams {
  tenantId: string;
  policy: UsageQuotaPolicy;
  /** Projected tokens for the next call (input + output estimate). */
  additionalTokensEstimate: number;
  /** Projected cost (USD) for the next call. */
  additionalCostEstimate: number;
}

/**
 * Pluggable metering store. Implementations must isolate by tenant
 * and persist `UsageMeterEntry` records durably enough to back the
 * quota check window (1 UTC day, minimum).
 */
export interface UsageMeter {
  /** Append a usage record. Storage is append-only by contract. */
  record(entry: UsageMeterEntry): Promise<void>;

  /**
   * Sum tokens and cost for one tenant in `[since, until)`. Both
   * bounds are ISO-8601 strings; `since` is inclusive, `until` is
   * exclusive so adjacent windows can be stitched without overlap.
   */
  aggregate(params: AggregateUsageParams): Promise<UsageAggregate>;

  /**
   * Decide whether a projected call fits inside today's quota. The
   * check aggregates the current UTC day, adds the projected
   * `additionalTokensEstimate` / `additionalCostEstimate`, and
   * compares against `policy`. Soft-warning state is reported when
   * the projection crosses `softWarnThreshold` without breaching the
   * hard limit.
   */
  checkQuota(params: CheckQuotaParams): Promise<QuotaCheckResult>;
}

// ── In-Memory Implementation ────────────────────────────────

export interface InMemoryUsageMeterOptions {
  /**
   * Override the wall clock — useful for deterministic tests of
   * day-boundary behavior. Defaults to `() => Date.now()`.
   */
  now?: () => number;
}

export function createInMemoryUsageMeter(options?: InMemoryUsageMeterOptions): UsageMeter {
  // Per-tenant chronological log. We keep the full history (callers
  // can prune via a wrapper if needed) so aggregation over arbitrary
  // windows stays exact.
  const entriesByTenant: Map<string, UsageMeterEntry[]> = new Map();
  const now = options?.now ?? (() => Date.now());

  function getEntries(tenantId: string): UsageMeterEntry[] {
    let list = entriesByTenant.get(tenantId);
    if (!list) {
      list = [];
      entriesByTenant.set(tenantId, list);
    }
    return list;
  }

  return {
    async record(entry) {
      validateEntry(entry);
      const list = getEntries(entry.tenantId);
      list.push({ ...entry });
    },

    async aggregate({ tenantId, since, until }) {
      assertNonEmpty(tenantId, "tenantId");
      const sinceMs = parseIso(since, "since");
      const untilMs = parseIso(until, "until");
      if (untilMs < sinceMs) {
        throw new Error("UsageMeter.aggregate: 'until' must be >= 'since'");
      }
      const list = entriesByTenant.get(tenantId) ?? [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCostUsd = 0;
      for (const entry of list) {
        const ts = parseIso(entry.ts, "entry.ts");
        if (ts >= sinceMs && ts < untilMs) {
          totalInputTokens += entry.inputTokens;
          totalOutputTokens += entry.outputTokens;
          totalCostUsd += entry.costUsd;
        }
      }
      return { totalInputTokens, totalOutputTokens, totalCostUsd };
    },

    async checkQuota({ tenantId, policy, additionalTokensEstimate, additionalCostEstimate }) {
      assertNonEmpty(tenantId, "tenantId");
      validatePolicy(policy);
      if (!Number.isFinite(additionalTokensEstimate) || additionalTokensEstimate < 0) {
        throw new Error(
          "UsageMeter.checkQuota: additionalTokensEstimate must be a non-negative finite number",
        );
      }
      if (!Number.isFinite(additionalCostEstimate) || additionalCostEstimate < 0) {
        throw new Error(
          "UsageMeter.checkQuota: additionalCostEstimate must be a non-negative finite number",
        );
      }

      const { startIso, endIso } = utcDayWindow(now());
      const { totalInputTokens, totalOutputTokens, totalCostUsd } = await this.aggregate({
        tenantId,
        since: startIso,
        until: endIso,
      });
      const usedTokens = totalInputTokens + totalOutputTokens;

      const projectedTokens = usedTokens + additionalTokensEstimate;
      const projectedCost = totalCostUsd + additionalCostEstimate;

      const remainingTokens = policy.maxTokensPerDay - usedTokens;
      const remainingCostUsd = policy.maxCostUsdPerDay - totalCostUsd;

      // Hard limits first — token cap before cost cap so the reason
      // string is stable when both would trip on the same call.
      if (projectedTokens > policy.maxTokensPerDay) {
        return {
          allowed: false,
          reason: "token_limit",
          remainingTokens,
          remainingCostUsd,
        };
      }
      if (projectedCost > policy.maxCostUsdPerDay) {
        return {
          allowed: false,
          reason: "cost_limit",
          remainingTokens,
          remainingCostUsd,
        };
      }

      // Soft warning — opt-in via softWarnThreshold. The projection
      // (not the current usage) is what trips the warning so callers
      // get a single signal per crossing rather than oscillating.
      if (policy.softWarnThreshold !== undefined) {
        const threshold = policy.softWarnThreshold;
        const tokenRatio = projectedTokens / policy.maxTokensPerDay;
        const costRatio = projectedCost / policy.maxCostUsdPerDay;
        if (tokenRatio >= threshold || costRatio >= threshold) {
          return {
            allowed: true,
            reason: "soft_warning",
            remainingTokens,
            remainingCostUsd,
          };
        }
      }

      return {
        allowed: true,
        reason: "ok",
        remainingTokens,
        remainingCostUsd,
      };
    },
  };
}

// ── Internal helpers ────────────────────────────────────────

/**
 * Compute the UTC calendar day containing `epochMs`. Returns
 * `[startIso, endIso)` — start inclusive, end exclusive — so
 * `aggregate()` semantics line up exactly.
 */
function utcDayWindow(epochMs: number): { startIso: string; endIso: string } {
  const start = new Date(epochMs);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function parseIso(value: string, name: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`UsageMeter: ${name} is not a valid ISO-8601 timestamp`);
  }
  return ms;
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`UsageMeter: ${name} must be a non-empty string`);
  }
}

function validateEntry(entry: UsageMeterEntry): void {
  assertNonEmpty(entry.tenantId, "entry.tenantId");
  assertNonEmpty(entry.provider, "entry.provider");
  assertNonEmpty(entry.model, "entry.model");
  assertNonEmpty(entry.ts, "entry.ts");
  parseIso(entry.ts, "entry.ts");
  if (!Number.isFinite(entry.inputTokens) || entry.inputTokens < 0) {
    throw new Error("UsageMeter: entry.inputTokens must be a non-negative finite number");
  }
  if (!Number.isFinite(entry.outputTokens) || entry.outputTokens < 0) {
    throw new Error("UsageMeter: entry.outputTokens must be a non-negative finite number");
  }
  if (!Number.isFinite(entry.costUsd) || entry.costUsd < 0) {
    throw new Error("UsageMeter: entry.costUsd must be a non-negative finite number");
  }
}

function validatePolicy(policy: UsageQuotaPolicy): void {
  if (!Number.isFinite(policy.maxTokensPerDay) || policy.maxTokensPerDay < 0) {
    throw new Error("UsageMeter: policy.maxTokensPerDay must be a non-negative finite number");
  }
  if (!Number.isFinite(policy.maxCostUsdPerDay) || policy.maxCostUsdPerDay < 0) {
    throw new Error("UsageMeter: policy.maxCostUsdPerDay must be a non-negative finite number");
  }
  if (policy.softWarnThreshold !== undefined) {
    const t = policy.softWarnThreshold;
    if (!Number.isFinite(t) || t <= 0 || t >= 1) {
      throw new Error("UsageMeter: policy.softWarnThreshold must be in (0, 1)");
    }
  }
}
