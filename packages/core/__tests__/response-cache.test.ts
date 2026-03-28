import { describe, expect, it } from "bun:test";
import { AIResponseCache } from "../src/ai/response-cache";
import type { AICompletionOptions, AICompletionResult } from "../src/types/ai";

// ── Fixtures ─────────────────────────────────────────────

function makeOptions(overrides: Partial<AICompletionOptions> = {}): AICompletionOptions {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    temperature: 0,
    ...overrides,
  };
}

function makeResult(content = "response"): AICompletionResult {
  return {
    content,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: "gpt-4o",
  };
}

// ── AIResponseCache ──────────────────────────────────────

describe("AIResponseCache", () => {
  describe("cache hit / miss", () => {
    it("returns undefined on cache miss", () => {
      const cache = new AIResponseCache({ enabled: true });
      const result = cache.get(makeOptions());
      expect(result).toBeUndefined();
    });

    it("returns cached result on hit", () => {
      const cache = new AIResponseCache({ enabled: true });
      const opts = makeOptions();
      const res = makeResult();
      cache.set(opts, res);
      const hit = cache.get(opts);
      expect(hit).toBeDefined();
      expect(hit?.content).toBe("response");
    });

    it("marks hit result with cached: true", () => {
      const cache = new AIResponseCache({ enabled: true });
      const opts = makeOptions();
      cache.set(opts, makeResult());
      const hit = cache.get(opts);
      expect(hit?.cached).toBe(true);
    });

    it("uses different keys for different messages", () => {
      const cache = new AIResponseCache({ enabled: true });
      const opts1 = makeOptions({ messages: [{ role: "user", content: "Hello" }] });
      const opts2 = makeOptions({ messages: [{ role: "user", content: "Goodbye" }] });
      cache.set(opts1, makeResult("hello response"));
      expect(cache.get(opts2)).toBeUndefined();
    });

    it("uses different keys for different models", () => {
      const cache = new AIResponseCache({ enabled: true });
      const opts1 = makeOptions({ model: "gpt-4o" });
      const opts2 = makeOptions({ model: "claude-sonnet-4-20250514" });
      cache.set(opts1, makeResult("gpt response"));
      expect(cache.get(opts2)).toBeUndefined();
    });
  });

  describe("non-cacheable requests", () => {
    it("does not cache tool-calling requests", () => {
      const cache = new AIResponseCache({ enabled: true });
      const opts = makeOptions({
        tools: [{ name: "search", description: "search tool", parameters: { type: "object", properties: {} } }],
      });
      cache.set(opts, makeResult());
      expect(cache.get(opts)).toBeUndefined();
    });

    it("does not cache requests with temperature > 0", () => {
      const cache = new AIResponseCache({ enabled: true });
      const opts = makeOptions({ temperature: 0.5 });
      cache.set(opts, makeResult());
      expect(cache.get(opts)).toBeUndefined();
    });

    it("does not cache when cache: false is set explicitly", () => {
      const cache = new AIResponseCache({ enabled: true });
      const opts = makeOptions({ cache: false });
      cache.set(opts, makeResult());
      expect(cache.get(opts)).toBeUndefined();
    });
  });

  describe("model filter", () => {
    it("caches only models in the filter list", () => {
      const cache = new AIResponseCache({ enabled: true, modelFilter: ["gpt-4o"] });
      const allowed = makeOptions({ model: "gpt-4o" });
      const blocked = makeOptions({ model: "claude-sonnet-4-20250514" });
      cache.set(allowed, makeResult("allowed"));
      cache.set(blocked, makeResult("blocked"));
      expect(cache.get(allowed)?.content).toBe("allowed");
      expect(cache.get(blocked)).toBeUndefined();
    });
  });

  describe("TTL expiration", () => {
    it("returns undefined for expired entries", async () => {
      const cache = new AIResponseCache({ enabled: true, ttlMs: 10 });
      const opts = makeOptions();
      cache.set(opts, makeResult());
      await new Promise((r) => setTimeout(r, 20));
      expect(cache.get(opts)).toBeUndefined();
    });

    it("removes expired entry from cache on access", async () => {
      const cache = new AIResponseCache({ enabled: true, ttlMs: 10 });
      const opts = makeOptions();
      cache.set(opts, makeResult());
      expect(cache.size).toBe(1);
      await new Promise((r) => setTimeout(r, 20));
      cache.get(opts); // triggers TTL cleanup
      expect(cache.size).toBe(0);
    });
  });

  describe("LRU eviction", () => {
    it("evicts least recently used entry when at capacity", async () => {
      const cache = new AIResponseCache({ enabled: true, maxEntries: 2 });
      const opts1 = makeOptions({ messages: [{ role: "user", content: "msg1" }] });
      const opts2 = makeOptions({ messages: [{ role: "user", content: "msg2" }] });
      const opts3 = makeOptions({ messages: [{ role: "user", content: "msg3" }] });
      cache.set(opts1, makeResult("r1"));
      await new Promise((r) => setTimeout(r, 5));
      cache.set(opts2, makeResult("r2"));
      await new Promise((r) => setTimeout(r, 5));
      // Access opts1 to make it more recently used than opts2
      cache.get(opts1);
      await new Promise((r) => setTimeout(r, 5));
      // Adding opts3 should evict opts2 (least recently used)
      cache.set(opts3, makeResult("r3"));
      expect(cache.size).toBe(2);
      // opts1 was accessed most recently, should still be present
      expect(cache.get(opts1)?.content).toBe("r1");
    });
  });

  describe("clear", () => {
    it("clears all entries", () => {
      const cache = new AIResponseCache({ enabled: true });
      cache.set(makeOptions(), makeResult());
      expect(cache.size).toBe(1);
      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe("stats", () => {
    it("returns size, maxEntries, and ttlMs", () => {
      const cache = new AIResponseCache({ enabled: true, maxEntries: 500, ttlMs: 60_000 });
      cache.set(makeOptions(), makeResult());
      const stats = cache.stats();
      expect(stats.size).toBe(1);
      expect(stats.maxEntries).toBe(500);
      expect(stats.ttlMs).toBe(60_000);
    });
  });

  describe("tenant isolation", () => {
    it("uses different keys for different tenants", () => {
      const cache = new AIResponseCache({ enabled: true });
      const opts1 = makeOptions({ tenantId: "tenant-a" });
      const opts2 = makeOptions({ tenantId: "tenant-b" });
      cache.set(opts1, makeResult("tenant a response"));
      expect(cache.get(opts2)).toBeUndefined();
    });
  });
});
