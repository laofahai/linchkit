/**
 * Tests for AIResponseCache (cap-ai-provider)
 *
 * Covers:
 * - get/set and cache hit behavior
 * - TTL expiration
 * - LRU eviction when at capacity
 * - Non-cacheable requests (tool calls, temperature > 0, cache=false)
 * - Model filter (only cache whitelisted models)
 * - Cache statistics
 */

import { describe, expect, it } from "bun:test";
import { AIResponseCache } from "../src/response-cache";
import type { AICompletionOptions, AICompletionResult } from "@linchkit/core";

// ── Helpers ───────────────────────────────────────────────────

function makeOptions(overrides: Partial<AICompletionOptions> = {}): AICompletionOptions {
  return {
    messages: [{ role: "user", content: "Hello" }],
    model: "claude-sonnet-4-20250514",
    temperature: 0,
    ...overrides,
  };
}

function makeResult(text = "response"): AICompletionResult {
  return {
    text,
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("AIResponseCache", () => {
  describe("Basic get/set", () => {
    it("returns undefined on cache miss", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });
      expect(cache.get(makeOptions())).toBeUndefined();
    });

    it("returns cached result on cache hit", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });
      const opts = makeOptions();
      const result = makeResult("cached response");

      cache.set(opts, result);
      const hit = cache.get(opts);

      expect(hit).toBeDefined();
      expect(hit?.text).toBe("cached response");
    });

    it("marks cached result with cached=true flag", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });
      const opts = makeOptions();
      cache.set(opts, makeResult("test"));

      const hit = cache.get(opts);
      expect(hit?.cached).toBe(true);
    });

    it("different messages produce different cache keys", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });

      const opts1 = makeOptions({ messages: [{ role: "user", content: "Hello" }] });
      const opts2 = makeOptions({ messages: [{ role: "user", content: "World" }] });

      cache.set(opts1, makeResult("hello response"));
      cache.set(opts2, makeResult("world response"));

      expect(cache.get(opts1)?.text).toBe("hello response");
      expect(cache.get(opts2)?.text).toBe("world response");
    });

    it("different models produce different cache keys", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });

      const opts1 = makeOptions({ model: "model-a" });
      const opts2 = makeOptions({ model: "model-b" });

      cache.set(opts1, makeResult("a"));
      cache.set(opts2, makeResult("b"));

      expect(cache.get(opts1)?.text).toBe("a");
      expect(cache.get(opts2)?.text).toBe("b");
    });

    it("size reflects number of stored entries", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });

      expect(cache.size).toBe(0);
      cache.set(makeOptions({ model: "m1" }), makeResult());
      expect(cache.size).toBe(1);
      cache.set(makeOptions({ model: "m2" }), makeResult());
      expect(cache.size).toBe(2);
    });

    it("clear() resets cache to empty", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });
      cache.set(makeOptions(), makeResult());
      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get(makeOptions())).toBeUndefined();
    });
  });

  describe("TTL expiration", () => {
    it("returns undefined when TTL has elapsed", async () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 10 }); // 10ms TTL
      const opts = makeOptions();

      cache.set(opts, makeResult("ephemeral"));

      await new Promise((r) => setTimeout(r, 20));

      expect(cache.get(opts)).toBeUndefined();
    });

    it("returns cached result before TTL elapses", async () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 500 }); // 500ms TTL
      const opts = makeOptions();

      cache.set(opts, makeResult("fresh"));

      await new Promise((r) => setTimeout(r, 10));

      expect(cache.get(opts)?.text).toBe("fresh");
    });
  });

  describe("LRU eviction", () => {
    it("evicts least-recently-used entry when at maxEntries", () => {
      const cache = new AIResponseCache({ maxEntries: 3, ttlMs: 60_000 });

      // Fill cache with 3 entries
      const opts = (m: string) => makeOptions({ model: m });
      cache.set(opts("m1"), makeResult("m1"));
      cache.set(opts("m2"), makeResult("m2"));
      cache.set(opts("m3"), makeResult("m3"));

      expect(cache.size).toBe(3);

      // Access m2 and m3 to make m1 the LRU
      cache.get(opts("m2"));
      cache.get(opts("m3"));

      // Adding a 4th entry should evict m1
      cache.set(opts("m4"), makeResult("m4"));

      expect(cache.size).toBe(3);
      expect(cache.get(opts("m1"))).toBeUndefined(); // evicted
      expect(cache.get(opts("m4"))?.text).toBe("m4"); // present
    });
  });

  describe("Non-cacheable requests", () => {
    it("does not cache requests with tools (non-deterministic)", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });
      const opts = makeOptions({
        tools: [{ name: "search", description: "Search", parameters: { type: "object", properties: {}, required: [] } }],
      });

      cache.set(opts, makeResult("with-tools"));
      expect(cache.get(opts)).toBeUndefined();
    });

    it("does not cache requests with temperature > 0", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });
      const opts = makeOptions({ temperature: 0.7 });

      cache.set(opts, makeResult("hot"));
      expect(cache.get(opts)).toBeUndefined();
    });

    it("does not cache requests with cache=false", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });
      const opts = makeOptions({ cache: false });

      cache.set(opts, makeResult("no-cache"));
      expect(cache.get(opts)).toBeUndefined();
    });

    it("caches requests with temperature=0 (deterministic)", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });
      const opts = makeOptions({ temperature: 0 });

      cache.set(opts, makeResult("deterministic"));
      expect(cache.get(opts)?.text).toBe("deterministic");
    });
  });

  describe("Model filter", () => {
    it("caches only whitelisted models when modelFilter is set", () => {
      const cache = new AIResponseCache({
        maxEntries: 100,
        ttlMs: 60_000,
        modelFilter: ["allowed-model"],
      });

      const allowedOpts = makeOptions({ model: "allowed-model" });
      const blockedOpts = makeOptions({ model: "blocked-model" });

      cache.set(allowedOpts, makeResult("allowed"));
      cache.set(blockedOpts, makeResult("blocked"));

      expect(cache.get(allowedOpts)?.text).toBe("allowed");
      expect(cache.get(blockedOpts)).toBeUndefined();
    });

    it("caches all models when no modelFilter is configured", () => {
      const cache = new AIResponseCache({ maxEntries: 100, ttlMs: 60_000 });

      cache.set(makeOptions({ model: "any-model" }), makeResult("any"));
      expect(cache.get(makeOptions({ model: "any-model" }))?.text).toBe("any");
    });
  });

  describe("Statistics", () => {
    it("stats() returns size, maxEntries, ttlMs", () => {
      const cache = new AIResponseCache({ maxEntries: 50, ttlMs: 30_000 });
      cache.set(makeOptions(), makeResult());

      const stats = cache.stats();
      expect(stats.size).toBe(1);
      expect(stats.maxEntries).toBe(50);
      expect(stats.ttlMs).toBe(30_000);
    });
  });
});
