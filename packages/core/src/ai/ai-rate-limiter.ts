/**
 * AI Rate Limiter
 *
 * Standalone sliding-window rate limiter for AI operations.
 * Supports per-user and per-tenant limits with configurable windows.
 * In-memory implementation — no external dependencies.
 *
 * Unlike the budget tracking in AIBoundary (which uses fixed-window counters
 * that reset on hour/day boundaries), this limiter uses a true sliding window
 * for more accurate rate enforcement.
 */

// ── Types ───────────────────────────────────────────────────

/** Configuration for a single rate limit window */
export interface RateLimitWindow {
  /** Window duration in milliseconds */
  windowMs: number;

  /** Maximum number of requests allowed in this window */
  maxRequests: number;
}

/** Configuration for the rate limiter */
export interface AIRateLimiterConfig {
  /** Rate limit windows to enforce (all must pass for a request to be allowed) */
  windows: RateLimitWindow[];

  /** Optional per-hour token budget (total tokens consumed) */
  maxTokensPerHour?: number;

  /** Whether to track per-user (true) or only per-tenant (false). Default: true */
  perUser?: boolean;

  /** Maximum number of tracked keys before evicting stale entries. Default: 10000 */
  maxTrackedKeys?: number;
}

/** Result of a rate limit check */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;

  /** Milliseconds until the caller should retry (only set when blocked) */
  retryAfterMs?: number;

  /** Current request count in the most restrictive window that blocked */
  currentCount?: number;

  /** The limit that was hit (only set when blocked) */
  limit?: number;

  /** Reason for blocking (only set when blocked) */
  reason?: string;
}

/** Internal record of a single request timestamp + optional token count */
interface RequestEntry {
  timestamp: number;
  tokens?: number;
}

// ── Default Config ──────────────────────────────────────────

const DEFAULT_WINDOWS: RateLimitWindow[] = [
  { windowMs: 60_000, maxRequests: 20 }, // 20 per minute
  { windowMs: 3_600_000, maxRequests: 200 }, // 200 per hour
];

// ── Rate Limiter ────────────────────────────────────────────

export class AIRateLimiter {
  private readonly windows: RateLimitWindow[];
  private readonly maxTokensPerHour: number | undefined;
  private readonly perUser: boolean;
  private readonly maxTrackedKeys: number;

  /**
   * Map of rate-limit key -> list of request entries.
   * Key format: "tenant:{tenantId}" or "user:{userId}@{tenantId}"
   */
  private readonly entries: Map<string, RequestEntry[]> = new Map();

  constructor(config?: Partial<AIRateLimiterConfig>) {
    this.windows = config?.windows ?? DEFAULT_WINDOWS;
    this.maxTokensPerHour = config?.maxTokensPerHour;
    this.perUser = config?.perUser ?? true;
    this.maxTrackedKeys = config?.maxTrackedKeys ?? 10_000;
  }

  /**
   * Check whether a request is allowed under current rate limits.
   * Does NOT record the request — call `record()` after the request succeeds.
   */
  check(identity: { tenantId?: string; userId?: string }): RateLimitResult {
    const key = this.buildKey(identity);
    const now = Date.now();
    const entries = this.getEntries(key);

    // Check each window
    for (const window of this.windows) {
      const cutoff = now - window.windowMs;
      const count = countSince(entries, cutoff);

      if (count >= window.maxRequests) {
        // Find the oldest entry in this window to calculate retry time
        const oldestInWindow = findOldestSince(entries, cutoff);
        const retryAfterMs = oldestInWindow
          ? oldestInWindow.timestamp + window.windowMs - now
          : window.windowMs;

        return {
          allowed: false,
          retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
          currentCount: count,
          limit: window.maxRequests,
          reason: `Rate limit exceeded: ${count}/${window.maxRequests} requests in ${formatDuration(window.windowMs)}`,
        };
      }
    }

    // Check token budget (hourly)
    if (this.maxTokensPerHour != null) {
      const hourCutoff = now - 3_600_000;
      const tokensUsed = sumTokensSince(entries, hourCutoff);

      if (tokensUsed >= this.maxTokensPerHour) {
        const oldestInHour = findOldestSince(entries, hourCutoff);
        const retryAfterMs = oldestInHour ? oldestInHour.timestamp + 3_600_000 - now : 3_600_000;

        return {
          allowed: false,
          retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
          reason: `Token budget exceeded: ${tokensUsed}/${this.maxTokensPerHour} tokens per hour`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a completed request. Call this after a successful AI call.
   * Optionally include token count for token-budget tracking.
   */
  record(identity: { tenantId?: string; userId?: string }, tokens?: number): void {
    const key = this.buildKey(identity);
    const entries = this.getEntries(key);
    entries.push({ timestamp: Date.now(), tokens });

    // Prune old entries beyond the largest window
    this.pruneEntries(key, entries);

    // Evict stale keys if we're over the limit
    if (this.entries.size > this.maxTrackedKeys) {
      this.evictStaleKeys();
    }
  }

  /**
   * Get current usage stats for a given identity.
   */
  getStats(identity: { tenantId?: string; userId?: string }): {
    requestsPerWindow: { windowMs: number; count: number; limit: number }[];
    tokensPerHour?: { used: number; limit: number };
  } {
    const key = this.buildKey(identity);
    const entries = this.getEntries(key);
    const now = Date.now();

    const requestsPerWindow = this.windows.map((w) => ({
      windowMs: w.windowMs,
      count: countSince(entries, now - w.windowMs),
      limit: w.maxRequests,
    }));

    let tokensPerHour: { used: number; limit: number } | undefined;
    if (this.maxTokensPerHour != null) {
      tokensPerHour = {
        used: sumTokensSince(entries, now - 3_600_000),
        limit: this.maxTokensPerHour,
      };
    }

    return { requestsPerWindow, tokensPerHour };
  }

  /** Reset all entries for a given identity */
  reset(identity: { tenantId?: string; userId?: string }): void {
    const key = this.buildKey(identity);
    this.entries.delete(key);
  }

  /** Reset all tracked entries */
  resetAll(): void {
    this.entries.clear();
  }

  // ── Private helpers ─────────────────────────────────────

  private buildKey(identity: { tenantId?: string; userId?: string }): string {
    if (this.perUser && identity.userId) {
      return `user:${identity.userId}@${identity.tenantId ?? "_"}`;
    }
    return `tenant:${identity.tenantId ?? "_global"}`;
  }

  private getEntries(key: string): RequestEntry[] {
    let entries = this.entries.get(key);
    if (!entries) {
      entries = [];
      this.entries.set(key, entries);
    }
    return entries;
  }

  private pruneEntries(key: string, entries: RequestEntry[]): void {
    // Find the largest window to determine the oldest entry we need to keep
    const maxWindowMs = Math.max(
      ...this.windows.map((w) => w.windowMs),
      this.maxTokensPerHour != null ? 3_600_000 : 0,
    );
    const cutoff = Date.now() - maxWindowMs;

    // Remove entries older than the largest window
    const firstValid = entries.findIndex((e) => e.timestamp >= cutoff);
    if (firstValid > 0) {
      entries.splice(0, firstValid);
    } else if (firstValid === -1 && entries.length > 0) {
      // All entries are stale
      entries.length = 0;
      this.entries.delete(key);
    }
  }

  private evictStaleKeys(): void {
    const maxWindowMs = Math.max(
      ...this.windows.map((w) => w.windowMs),
      this.maxTokensPerHour != null ? 3_600_000 : 0,
    );
    const cutoff = Date.now() - maxWindowMs;

    for (const [key, entries] of this.entries) {
      const last = entries[entries.length - 1];
      if (entries.length === 0 || (last && last.timestamp < cutoff)) {
        this.entries.delete(key);
      }
    }
  }
}

// ── Utility functions ───────────────────────────────────────

function countSince(entries: RequestEntry[], cutoff: number): number {
  let count = 0;
  // Iterate from end (most recent) for efficiency
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.timestamp >= cutoff) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function findOldestSince(entries: RequestEntry[], cutoff: number): RequestEntry | undefined {
  for (const entry of entries) {
    if (entry.timestamp >= cutoff) {
      return entry;
    }
  }
  return undefined;
}

function sumTokensSince(entries: RequestEntry[], cutoff: number): number {
  let sum = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.timestamp >= cutoff) {
      sum += entry.tokens ?? 0;
    } else {
      break;
    }
  }
  return sum;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
