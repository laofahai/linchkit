import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIRateLimiter } from "../src/ai/ai-rate-limiter";

describe("AIRateLimiter", () => {
  let limiter: AIRateLimiter;

  afterEach(() => {
    limiter?.resetAll();
  });

  // ── Basic rate limiting ───────────────────────────────

  test("allows requests under the limit", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 5 }],
    });

    const identity = { tenantId: "t1", userId: "u1" };
    for (let i = 0; i < 5; i++) {
      const result = limiter.check(identity);
      expect(result.allowed).toBe(true);
      limiter.record(identity);
    }
  });

  test("blocks requests over the limit", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 3 }],
    });

    const identity = { tenantId: "t1", userId: "u1" };
    for (let i = 0; i < 3; i++) {
      limiter.record(identity);
    }

    const result = limiter.check(identity);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.currentCount).toBe(3);
    expect(result.limit).toBe(3);
    expect(result.reason).toContain("Rate limit exceeded");
  });

  test("returns retryAfterMs when blocked", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 10_000, maxRequests: 1 }],
    });

    const identity = { tenantId: "t1" };
    limiter.record(identity);

    const result = limiter.check(identity);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeDefined();
    expect(result.retryAfterMs!).toBeGreaterThan(0);
    expect(result.retryAfterMs!).toBeLessThanOrEqual(10_000);
  });

  // ── Per-user isolation ────────────────────────────────

  test("isolates rate limits per user", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 2 }],
      perUser: true,
    });

    const user1 = { tenantId: "t1", userId: "u1" };
    const user2 = { tenantId: "t1", userId: "u2" };

    // Fill user1's quota
    limiter.record(user1);
    limiter.record(user1);

    // User1 should be blocked
    expect(limiter.check(user1).allowed).toBe(false);

    // User2 should still be allowed
    expect(limiter.check(user2).allowed).toBe(true);
  });

  test("isolates rate limits per tenant", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 2 }],
      perUser: false,
    });

    const tenant1 = { tenantId: "t1", userId: "u1" };
    const tenant2 = { tenantId: "t2", userId: "u1" };

    limiter.record(tenant1);
    limiter.record(tenant1);

    expect(limiter.check(tenant1).allowed).toBe(false);
    expect(limiter.check(tenant2).allowed).toBe(true);
  });

  test("groups users under same tenant when perUser is false", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 2 }],
      perUser: false,
    });

    const user1 = { tenantId: "t1", userId: "u1" };
    const user2 = { tenantId: "t1", userId: "u2" };

    limiter.record(user1);
    limiter.record(user2);

    // Both count against tenant t1
    expect(limiter.check(user1).allowed).toBe(false);
    expect(limiter.check(user2).allowed).toBe(false);
  });

  // ── Multiple windows ──────────────────────────────────

  test("enforces multiple windows simultaneously", () => {
    limiter = new AIRateLimiter({
      windows: [
        { windowMs: 1_000, maxRequests: 2 }, // 2 per second
        { windowMs: 60_000, maxRequests: 10 }, // 10 per minute
      ],
    });

    const identity = { tenantId: "t1" };

    // Record 2 requests — should hit the per-second limit
    limiter.record(identity);
    limiter.record(identity);

    const result = limiter.check(identity);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("1s");
  });

  // ── Token budget ──────────────────────────────────────

  test("enforces token budget per hour", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 100 }],
      maxTokensPerHour: 1000,
    });

    const identity = { tenantId: "t1" };

    // Record requests with tokens
    limiter.record(identity, 500);
    limiter.record(identity, 500);

    const result = limiter.check(identity);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Token budget exceeded");
  });

  test("allows requests when under token budget", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 100 }],
      maxTokensPerHour: 1000,
    });

    const identity = { tenantId: "t1" };
    limiter.record(identity, 400);

    expect(limiter.check(identity).allowed).toBe(true);
  });

  // ── Stats ─────────────────────────────────────────────

  test("returns accurate stats", () => {
    limiter = new AIRateLimiter({
      windows: [
        { windowMs: 60_000, maxRequests: 10 },
        { windowMs: 3_600_000, maxRequests: 100 },
      ],
      maxTokensPerHour: 5000,
    });

    const identity = { tenantId: "t1", userId: "u1" };
    limiter.record(identity, 100);
    limiter.record(identity, 200);

    const stats = limiter.getStats(identity);
    expect(stats.requestsPerWindow).toHaveLength(2);
    expect(stats.requestsPerWindow[0].count).toBe(2);
    expect(stats.requestsPerWindow[0].limit).toBe(10);
    expect(stats.tokensPerHour).toBeDefined();
    expect(stats.tokensPerHour!.used).toBe(300);
    expect(stats.tokensPerHour!.limit).toBe(5000);
  });

  // ── Reset ─────────────────────────────────────────────

  test("reset clears entries for a specific identity", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 1 }],
    });

    const identity = { tenantId: "t1" };
    limiter.record(identity);
    expect(limiter.check(identity).allowed).toBe(false);

    limiter.reset(identity);
    expect(limiter.check(identity).allowed).toBe(true);
  });

  test("resetAll clears all entries", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 1 }],
    });

    limiter.record({ tenantId: "t1" });
    limiter.record({ tenantId: "t2" });

    limiter.resetAll();

    expect(limiter.check({ tenantId: "t1" }).allowed).toBe(true);
    expect(limiter.check({ tenantId: "t2" }).allowed).toBe(true);
  });

  // ── Default config ────────────────────────────────────

  test("uses sensible defaults when no config provided", () => {
    limiter = new AIRateLimiter();
    const identity = { tenantId: "t1" };

    // Should allow at least a few requests with defaults
    const result = limiter.check(identity);
    expect(result.allowed).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────

  test("handles identity with no tenantId or userId", () => {
    limiter = new AIRateLimiter({
      windows: [{ windowMs: 60_000, maxRequests: 2 }],
    });

    const identity = {};
    limiter.record(identity);
    limiter.record(identity);

    expect(limiter.check(identity).allowed).toBe(false);
  });
});
