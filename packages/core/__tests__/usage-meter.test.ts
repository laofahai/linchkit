import { describe, expect, test } from "bun:test";
import { createInMemoryUsageMeter } from "../src/ai/usage-meter";

/**
 * Anchor "now" to a stable point inside the UTC day 2026-05-18 so the
 * quota-check window is deterministic across machines / timezones.
 */
const FIXED_NOW_MS = Date.UTC(2026, 4, 18, 12, 0, 0); // 2026-05-18T12:00:00Z
const fixedNow = () => FIXED_NOW_MS;

describe("createInMemoryUsageMeter", () => {
  // ── record + aggregate ─────────────────────────────────────

  test("record + aggregate sums a single UTC day correctly", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.25,
      ts: "2026-05-18T01:00:00Z",
    });
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 200,
      outputTokens: 75,
      costUsd: 0.5,
      ts: "2026-05-18T05:30:00Z",
    });

    const agg = await meter.aggregate({
      tenantId: "tenant-a",
      since: "2026-05-18T00:00:00Z",
      until: "2026-05-19T00:00:00Z",
    });

    expect(agg.totalInputTokens).toBe(300);
    expect(agg.totalOutputTokens).toBe(125);
    expect(agg.totalCostUsd).toBeCloseTo(0.75, 10);
  });

  test("aggregate respects UTC day boundary (excludes prior day, includes 00:00 start)", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });
    // Just before window
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      ts: "2026-05-17T23:59:59.999Z",
    });
    // Exactly at start of window — inclusive
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.1,
      ts: "2026-05-18T00:00:00.000Z",
    });
    // Inside window
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.2,
      ts: "2026-05-18T15:00:00.000Z",
    });
    // Exactly at exclusive upper bound — excluded
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 1000,
      outputTokens: 1000,
      costUsd: 99,
      ts: "2026-05-19T00:00:00.000Z",
    });

    const agg = await meter.aggregate({
      tenantId: "tenant-a",
      since: "2026-05-18T00:00:00.000Z",
      until: "2026-05-19T00:00:00.000Z",
    });

    expect(agg.totalInputTokens).toBe(300);
    expect(agg.totalOutputTokens).toBe(150);
    expect(agg.totalCostUsd).toBeCloseTo(0.3, 10);
  });

  // ── checkQuota: allow ──────────────────────────────────────

  test("checkQuota allows when projected usage stays under both hard limits", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.1,
      ts: "2026-05-18T01:00:00Z",
    });

    const result = await meter.checkQuota({
      tenantId: "tenant-a",
      policy: { maxTokensPerDay: 1000, maxCostUsdPerDay: 5 },
      additionalTokensEstimate: 100,
      additionalCostEstimate: 0.5,
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.remainingTokens).toBe(850); // 1000 - (100 + 50)
    expect(result.remainingCostUsd).toBeCloseTo(4.9, 10); // 5 - 0.1
  });

  // ── checkQuota: deny on tokens ─────────────────────────────

  test("checkQuota denies when projected tokens exceed maxTokensPerDay", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 500,
      outputTokens: 400,
      costUsd: 0.5,
      ts: "2026-05-18T01:00:00Z",
    });

    const result = await meter.checkQuota({
      tenantId: "tenant-a",
      policy: { maxTokensPerDay: 1000, maxCostUsdPerDay: 100 },
      additionalTokensEstimate: 200, // 900 + 200 = 1100 > 1000
      additionalCostEstimate: 0.1,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("token_limit");
    expect(result.remainingTokens).toBe(100); // 1000 - 900
  });

  // ── checkQuota: deny on cost ───────────────────────────────

  test("checkQuota denies when projected cost exceeds maxCostUsdPerDay", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 4.5,
      ts: "2026-05-18T01:00:00Z",
    });

    const result = await meter.checkQuota({
      tenantId: "tenant-a",
      policy: { maxTokensPerDay: 100_000, maxCostUsdPerDay: 5 },
      additionalTokensEstimate: 100,
      additionalCostEstimate: 1, // 4.5 + 1 = 5.5 > 5
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("cost_limit");
    expect(result.remainingCostUsd).toBeCloseTo(0.5, 10);
  });

  // ── checkQuota: soft warning ───────────────────────────────

  test("checkQuota raises soft_warning when projection crosses threshold but stays under hard limit", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 400,
      outputTokens: 300,
      costUsd: 0.1,
      ts: "2026-05-18T01:00:00Z",
    });

    const result = await meter.checkQuota({
      tenantId: "tenant-a",
      policy: {
        maxTokensPerDay: 1000,
        maxCostUsdPerDay: 100,
        softWarnThreshold: 0.8,
      },
      additionalTokensEstimate: 200, // 700 + 200 = 900 >= 80% of 1000
      additionalCostEstimate: 0.1,
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("soft_warning");
    expect(result.remainingTokens).toBe(300); // 1000 - 700
  });

  // ── Tenant isolation ───────────────────────────────────────

  test("aggregate isolates per tenant (tenant-A records do not leak into tenant-B sum)", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.25,
      ts: "2026-05-18T01:00:00Z",
    });
    await meter.record({
      tenantId: "tenant-b",
      provider: "openai",
      model: "gpt-4",
      inputTokens: 999,
      outputTokens: 999,
      costUsd: 9.99,
      ts: "2026-05-18T02:00:00Z",
    });

    const aggA = await meter.aggregate({
      tenantId: "tenant-a",
      since: "2026-05-18T00:00:00Z",
      until: "2026-05-19T00:00:00Z",
    });
    expect(aggA.totalInputTokens).toBe(100);
    expect(aggA.totalOutputTokens).toBe(50);
    expect(aggA.totalCostUsd).toBeCloseTo(0.25, 10);

    const aggB = await meter.aggregate({
      tenantId: "tenant-b",
      since: "2026-05-18T00:00:00Z",
      until: "2026-05-19T00:00:00Z",
    });
    expect(aggB.totalInputTokens).toBe(999);
    expect(aggB.totalOutputTokens).toBe(999);
    expect(aggB.totalCostUsd).toBeCloseTo(9.99, 10);
  });

  // ── Empty result ───────────────────────────────────────────

  test("aggregate returns zeroed totals when no records fall in the window", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });
    // Record exists, but on a different day.
    await meter.record({
      tenantId: "tenant-a",
      provider: "anthropic",
      model: "claude-3-opus",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.5,
      ts: "2026-05-10T01:00:00Z",
    });

    const agg = await meter.aggregate({
      tenantId: "tenant-a",
      since: "2026-05-18T00:00:00Z",
      until: "2026-05-19T00:00:00Z",
    });

    expect(agg.totalInputTokens).toBe(0);
    expect(agg.totalOutputTokens).toBe(0);
    expect(agg.totalCostUsd).toBe(0);
  });

  // ── Empty store ────────────────────────────────────────────

  test("aggregate on tenant with no recorded usage returns all zeros", async () => {
    const meter = createInMemoryUsageMeter({ now: fixedNow });

    const agg = await meter.aggregate({
      tenantId: "tenant-empty",
      since: "2026-05-18T00:00:00Z",
      until: "2026-05-19T00:00:00Z",
    });

    expect(agg).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
    });
  });
});
