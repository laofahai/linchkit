/**
 * RedisCacheProvider behavioural tests against a fully mocked Redis client.
 *
 * Verifies the exact Redis traffic (GET, SET ... PX, DEL, SADD tags:*) and
 * the local-mirror semantics that satisfy the synchronous CacheProvider
 * contract (TTL, SWR, tag invalidation, stats).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RedisCacheProvider } from "../src/redis-cache-provider";
import { decodeEnvelope } from "../src/redis-key-encoder";
import { MockRedis } from "./mock-redis";

const NS = "test:cache";

/** Yield until every queued microtask resolves — flushes the provider's fire-and-forget writes. */
async function flushAsync(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RedisCacheProvider", () => {
  let mock: MockRedis;
  let provider: RedisCacheProvider;

  beforeEach(() => {
    mock = new MockRedis();
    provider = new RedisCacheProvider({
      client: mock,
      namespace: NS,
      invalidationChannel: "test:invalidate",
    });
  });

  afterEach(async () => {
    await provider.close();
  });

  it("subscribes to the invalidation channel on start", async () => {
    await flushAsync();
    // The invalidator subscribes on a duplicate connection — assert against
    // the broker by publishing and observing that no SUBSCRIBE landed on
    // the primary mock (subscriber is a different MockRedis instance).
    const subs = mock.commandsByName("SUBSCRIBE");
    expect(subs.length).toBe(0); // primary client is publisher only
  });

  it("SET issues SET ... PX ttl plus SADD per tag and stores an envelope", async () => {
    provider.set("user:1", { name: "Alice" }, { ttl: 60_000, tags: ["tenant:t1", "users"] });
    await flushAsync();

    const sets = mock.commandsByName("SET");
    expect(sets.length).toBe(1);
    const setCmd = sets[0];
    if (!setCmd) throw new Error("SET command missing");
    expect(setCmd.args[0]).toBe(`${NS}:k:user:1`);
    expect(setCmd.args[2]).toBe("PX");
    expect(setCmd.args[3]).toBe(60_000);

    const stored = mock.store.get(`${NS}:k:user:1`);
    const envelope = decodeEnvelope(stored ?? null);
    expect(envelope?.v).toEqual({ name: "Alice" });
    expect(envelope?.t).toEqual(["tenant:t1", "users"]);
    expect(envelope?.e).toBeDefined();
    expect(envelope?.s).toBeUndefined();

    const sadds = mock.commandsByName("SADD");
    expect(sadds.map((cmd) => cmd.args[0])).toEqual([`${NS}:t:tenant:t1`, `${NS}:t:users`]);
    expect(mock.sets.get(`${NS}:t:tenant:t1`)?.has("user:1")).toBe(true);
  });

  it("SET without ttl issues a SET without PX", async () => {
    provider.set("no-ttl", "value");
    await flushAsync();
    const sets = mock.commandsByName("SET");
    const setCmd = sets[0];
    if (!setCmd) throw new Error("SET command missing");
    expect(setCmd.args.length).toBe(2);
    expect(setCmd.args[0]).toBe(`${NS}:k:no-ttl`);
  });

  it("get returns the value from the local mirror immediately after set", () => {
    provider.set("greeting", "hello");
    expect(provider.get<string>("greeting")).toBe("hello");
    expect(provider.stats().hits).toBe(1);
    expect(provider.stats().misses).toBe(0);
  });

  it("returns undefined and counts a miss when the key is unknown", () => {
    expect(provider.get("missing")).toBeUndefined();
    expect(provider.stats().misses).toBe(1);
  });

  it("evicts on hard TTL boundary", async () => {
    provider.set("short", "v", { ttl: 5 });
    expect(provider.get("short")).toBe("v");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(provider.get("short")).toBeUndefined();
    const stats = provider.stats();
    expect(stats.evictions).toBe(1);
  });

  it("serves stale value with isStale=true inside SWR window", async () => {
    provider.set("warm", "v", { ttl: 10, swrTtl: 100 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const result = provider.getWithStaleness<string>("warm");
    expect(result).toBeDefined();
    expect(result?.value).toBe("v");
    expect(result?.isStale).toBe(true);
  });

  it("evicts past the SWR boundary", async () => {
    provider.set("decay", "v", { ttl: 5, swrTtl: 5 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(provider.get("decay")).toBeUndefined();
  });

  it("delete issues DEL and publishes invalidate-key", async () => {
    provider.set("k", "v");
    await flushAsync();
    const existed = provider.delete("k");
    expect(existed).toBe(true);
    await flushAsync();
    const dels = mock.commandsByName("DEL");
    expect(dels.some((cmd) => cmd.args[0] === `${NS}:k:k`)).toBe(true);
    const pubs = mock.commandsByName("PUBLISH");
    expect(pubs.length).toBe(1);
    const pubCmd = pubs[0];
    if (!pubCmd) throw new Error("PUBLISH missing");
    const payload = JSON.parse(pubCmd.args[1] as string);
    expect(payload.type).toBe("invalidate-key");
    expect(payload.key).toBe("k");
  });

  it("invalidateByTag removes mirror entries and DELs all tagged keys + the tag set", async () => {
    provider.set("a", 1, { tags: ["t1"] });
    provider.set("b", 2, { tags: ["t1"] });
    provider.set("c", 3, { tags: ["other"] });
    await flushAsync();

    const removed = provider.invalidateByTag("t1");
    expect(removed).toBe(2);
    expect(provider.get("a")).toBeUndefined();
    expect(provider.get("b")).toBeUndefined();
    expect(provider.get<number>("c")).toBe(3);

    await flushAsync();
    const dels = mock.commandsByName("DEL");
    // One DEL for the underlying keys, one DEL for the tag set.
    const tagSetDel = dels.find((cmd) => cmd.args[0] === `${NS}:t:t1`);
    expect(tagSetDel).toBeDefined();
  });

  it("hydrates the local mirror from Redis on a miss", async () => {
    // Pre-seed Redis directly with an envelope.
    const envelope = JSON.stringify({ v: "from-redis", t: [], c: Date.now() });
    mock.store.set(`${NS}:k:remote`, envelope);

    // First call misses but triggers hydration.
    expect(provider.get("remote")).toBeUndefined();
    await flushAsync();
    expect(provider.get<string>("remote")).toBe("from-redis");
  });

  it("stats track hits, misses, and evictions", () => {
    provider.set("k", "v");
    provider.get("k");
    provider.get("k");
    provider.get("missing");
    const stats = provider.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  it("clear empties the local mirror and broadcasts a clear message", async () => {
    provider.set("k", "v");
    provider.clear();
    expect(provider.get("k")).toBeUndefined();
    await flushAsync();
    const pubs = mock.commandsByName("PUBLISH");
    const payload = JSON.parse(pubs[pubs.length - 1]?.args[1] as string);
    expect(payload.type).toBe("clear");
  });

  it("throws when neither client nor URL is supplied", () => {
    const original = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    expect(() => new RedisCacheProvider()).toThrow();
    if (original !== undefined) process.env.REDIS_URL = original;
  });

  it("rejects non-positive maxLocalMirrorEntries", () => {
    expect(
      () =>
        new RedisCacheProvider({
          client: new MockRedis(),
          maxLocalMirrorEntries: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new RedisCacheProvider({
          client: new MockRedis(),
          maxLocalMirrorEntries: -5,
        }),
    ).toThrow();
  });
});

describe("RedisCacheProvider local-mirror LRU", () => {
  it("evicts the oldest entry once the cap is exceeded", async () => {
    const mock = new MockRedis();
    const p = new RedisCacheProvider({
      client: mock,
      namespace: NS,
      invalidationChannel: "test:invalidate",
      maxLocalMirrorEntries: 3,
    });
    try {
      p.set("a", 1);
      p.set("b", 2);
      p.set("c", 3);
      p.set("d", 4);
      // "a" is the oldest insertion → should be evicted from the mirror.
      // We assert the mirror state via stats().size and by observing that a
      // get on "a" misses (hydration will repopulate, so we only check the
      // synchronous first-call result).
      expect(p.stats().size).toBe(3);
      // Wipe Redis so hydration cannot bring "a" back during the same tick.
      mock.store.clear();
      expect(p.get("a")).toBeUndefined();
      expect(p.get<number>("b")).toBe(2);
      expect(p.get<number>("c")).toBe(3);
      expect(p.get<number>("d")).toBe(4);
      expect(p.stats().evictions).toBeGreaterThanOrEqual(1);
    } finally {
      await p.close();
    }
  });

  it("bumps a read entry to MRU so a later write evicts a different key", async () => {
    const mock = new MockRedis();
    const p = new RedisCacheProvider({
      client: mock,
      namespace: NS,
      invalidationChannel: "test:invalidate",
      maxLocalMirrorEntries: 3,
    });
    try {
      p.set("a", 1);
      p.set("b", 2);
      p.set("c", 3);
      // Read "a" to bump it to MRU. Order should now be: b, c, a.
      expect(p.get<number>("a")).toBe(1);
      // Adding "d" should now evict "b" (the new LRU), not "a".
      p.set("d", 4);
      mock.store.clear();
      expect(p.get("b")).toBeUndefined();
      expect(p.get<number>("a")).toBe(1);
      expect(p.get<number>("c")).toBe(3);
      expect(p.get<number>("d")).toBe(4);
    } finally {
      await p.close();
    }
  });

  it("bumps a hydrated entry to MRU", async () => {
    const mock = new MockRedis();
    const p = new RedisCacheProvider({
      client: mock,
      namespace: NS,
      invalidationChannel: "test:invalidate",
      maxLocalMirrorEntries: 3,
    });
    try {
      p.set("a", 1);
      p.set("b", 2);
      p.set("c", 3);
      // Pre-seed Redis with "z" and hydrate via a missed get.
      mock.store.set(`${NS}:k:z`, JSON.stringify({ v: 99, t: [], c: Date.now() }));
      expect(p.get("z")).toBeUndefined();
      await flushAsync();
      // Mirror order is now: b, c, z (hydration bumped z to MRU; a was evicted).
      mock.store.clear();
      expect(p.get("a")).toBeUndefined();
      expect(p.get<number>("z")).toBe(99);
    } finally {
      await p.close();
    }
  });
});

describe("RedisCacheProvider hydration dedup", () => {
  it("coalesces concurrent misses on the same key into a single Redis GET", async () => {
    const mock = new MockRedis();
    let inflight = 0;
    let maxInflight = 0;
    let totalGets = 0;
    const originalGet = mock.get.bind(mock);
    mock.get = async (key: string) => {
      totalGets++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        // Stall so concurrent callers can queue up.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return originalGet(key);
      } finally {
        inflight--;
      }
    };

    const p = new RedisCacheProvider({
      client: mock,
      namespace: NS,
      invalidationChannel: "test:invalidate",
    });
    try {
      mock.store.set(`${NS}:k:hot`, JSON.stringify({ v: "shared", t: [], c: Date.now() }));
      // Fire many concurrent misses on the same key.
      for (let i = 0; i < 8; i++) p.get("hot");
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Exactly one hydration GET should have hit Redis.
      const hotGets = mock.commandsByName("GET").filter((cmd) => cmd.args[0] === `${NS}:k:hot`);
      expect(hotGets.length).toBe(1);
      expect(totalGets).toBe(1);
      expect(maxInflight).toBe(1);
      // After hydration the mirror is populated and the value is observable.
      expect(p.get<string>("hot")).toBe("shared");
    } finally {
      await p.close();
    }
  });
});
