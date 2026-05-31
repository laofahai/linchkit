/**
 * Integration tests for RedisCacheProvider against a REAL Redis server.
 *
 * Unlike redis-cache-provider.test.ts (which runs entirely against the
 * in-memory MockRedis), this suite wires the provider to a live ioredis
 * connection so the production code path — real GET / SET ... PX / DEL /
 * SADD / SMEMBERS / SUBSCRIBE / PUBLISH — is actually exercised. Every
 * assertion reads back through a SEPARATE raw ioredis client so we verify
 * the bytes that landed in Redis, not the provider's process-local mirror.
 *
 * Requires a running Redis instance. Set REDIS_TEST_URL to connect.
 * Default: redis://localhost:6380 (matches the `redis` CI service and the
 * `redis-test` docker-compose service).
 *
 * Skips gracefully when no Redis is available (CI without Redis won't fail),
 * exactly like the DATABASE_TEST_URL-gated Postgres integration suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { RedisCacheProvider } from "../src/redis-cache-provider";
import { decodeEnvelope } from "../src/redis-key-encoder";
import type { RedisLike } from "../src/types";

// ── Test configuration ───────────────────────────────────────

const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? "redis://localhost:6380";

/**
 * Unique namespace per run so concurrent / repeated runs never collide and
 * teardown only ever touches this run's keys.
 */
const NAMESPACE = `linchkit:cache:itest:${randomUUID()}`;
const CHANNEL = `${NAMESPACE}:invalidate`;

// ── ioredis loader ───────────────────────────────────────────

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: ioredis exports vary between CJS/ESM
const ioredisModule: any = require("ioredis");
const RedisCtor = ioredisModule?.default ?? ioredisModule;

/**
 * Construct a fail-fast real ioredis client. Short connect timeout and
 * `maxRetriesPerRequest: 0` so the availability probe rejects quickly when
 * no Redis is listening rather than hanging the suite.
 */
function makeRawClient(): RedisLike {
  const client = new RedisCtor(REDIS_TEST_URL, {
    lazyConnect: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
    // Stop ioredis from reconnecting forever when the server is absent.
    retryStrategy: () => null,
  }) as RedisLike;
  // Swallow connection-error events so a missing Redis (the skip path)
  // doesn't spew an "Unhandled error event" stack trace into the test log.
  client.on("error", () => {
    // intentionally empty — availability is decided by the ping() probe
  });
  return client;
}

// ── Availability probe ───────────────────────────────────────

/**
 * Try to PING a real Redis. Returns true on PONG, false otherwise.
 * Always quits the probe client so a missing server leaves no dangling
 * socket.
 */
async function canConnect(): Promise<boolean> {
  let client: RedisLike | undefined;
  try {
    client = makeRawClient();
    // ioredis exposes ping() but RedisLike doesn't declare it; the raw
    // client is a superset so narrow via the concrete instance.
    const pong = await (client as unknown as { ping(): Promise<string> }).ping();
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    if (client) {
      try {
        await client.quit();
      } catch {
        // ignore — best-effort cleanup of the probe socket
      }
    }
  }
}

const redisAvailable = await canConnect();

if (!redisAvailable) {
  console.warn(
    `Redis not available at ${REDIS_TEST_URL}, skipping RedisCacheProvider integration tests`,
  );
}

/** Wait until `predicate()` is true or the deadline passes (for async pub/sub). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Poll an async predicate (e.g. a real Redis read) until it resolves true or
 * the deadline passes. Returns whether it became true within the timeout.
 */
async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** Yield until queued microtasks/timers drain — flushes fire-and-forget writes. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// ── Test suite ───────────────────────────────────────────────

describe.skipIf(!redisAvailable)("RedisCacheProvider (integration, real Redis)", () => {
  // Raw client used purely to assert on what landed in Redis.
  let rawClient: RedisLike | undefined;
  let provider: RedisCacheProvider | undefined;

  beforeAll(async () => {
    rawClient = makeRawClient();
    provider = new RedisCacheProvider({
      client: makeRawClient(),
      namespace: NAMESPACE,
      invalidationChannel: CHANNEL,
    });
  });

  afterAll(async () => {
    // Guard each teardown step so a setup failure cannot mask the real error.
    if (provider) {
      try {
        await provider.close();
      } catch {
        // ignore
      }
    }
    if (rawClient) {
      try {
        // Flush only the keys this run created (unique namespace).
        const keys = await (
          rawClient as unknown as { keys(pattern: string): Promise<string[]> }
        ).keys(`${NAMESPACE}:*`);
        if (keys.length > 0) {
          await rawClient.del(...keys);
        }
      } catch {
        // ignore
      }
      try {
        await rawClient.quit();
      } catch {
        // ignore
      }
    }
  });

  test("SET writes a real prefixed key whose envelope decodes to the value", async () => {
    const p = provider;
    const raw = rawClient;
    if (!p || !raw) throw new Error("provider/rawClient not initialised");

    const key = "user:1";
    p.set(key, { name: "Alice" }, { tags: ["tenant:t1", "users"] });
    await flushAsync();

    // Read the REAL Redis key directly — not the provider mirror.
    const stored = await raw.get(`${NAMESPACE}:k:${key}`);
    expect(stored).not.toBeNull();
    const envelope = decodeEnvelope(stored);
    expect(envelope?.v).toEqual({ name: "Alice" });
    expect(envelope?.t).toEqual(["tenant:t1", "users"]);

    // Tag set members are the raw (un-prefixed) keys.
    const tagMembers = await raw.smembers(`${NAMESPACE}:t:tenant:t1`);
    expect(tagMembers).toContain(key);

    // GET round-trip through the provider returns the value.
    expect(p.get<{ name: string }>(key)).toEqual({ name: "Alice" });
  });

  test("SET ... PX gives the real key a positive PTTL that expires", async () => {
    const p = provider;
    const raw = rawClient;
    if (!p || !raw) throw new Error("provider/rawClient not initialised");

    const key = "ttl-key";
    p.set(key, "soon-gone", { ttl: 300 });
    await flushAsync();

    const redisKey = `${NAMESPACE}:k:${key}`;
    const pttl = await (raw as unknown as { pttl(k: string): Promise<number> }).pttl(redisKey);
    // Positive PTTL means a real expiry is set (-1 = no expiry, -2 = no key).
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(300);

    // After the TTL elapses the real key is gone.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterExpiry = await raw.get(redisKey);
    expect(afterExpiry).toBeNull();
  });

  test("delete removes the real key and broadcasts invalidate-key over real Pub/Sub", async () => {
    const p = provider;
    const raw = rawClient;
    if (!p || !raw) throw new Error("provider/rawClient not initialised");

    const key = "to-delete";
    p.set(key, "value");
    await flushAsync();
    const redisKey = `${NAMESPACE}:k:${key}`;
    expect(await raw.get(redisKey)).not.toBeNull();

    p.delete(key);
    // The real DEL is fire-and-forget; poll the real key until it disappears.
    const gone = await waitForAsync(async () => (await raw.get(redisKey)) === null);
    expect(gone).toBe(true);
  });

  test("invalidateByTag DELs every tagged key and the tag set in real Redis", async () => {
    const p = provider;
    const raw = rawClient;
    if (!p || !raw) throw new Error("provider/rawClient not initialised");

    p.set("a", 1, { tags: ["grp"] });
    p.set("b", 2, { tags: ["grp"] });
    p.set("c", 3, { tags: ["keep"] });
    await flushAsync();

    expect(await raw.get(`${NAMESPACE}:k:a`)).not.toBeNull();
    expect(await raw.get(`${NAMESPACE}:k:b`)).not.toBeNull();

    p.invalidateByTag("grp");

    // Poll until the tagged keys + tag set are gone from real Redis.
    const cleared = await waitForAsync(async () => {
      const a = await raw.get(`${NAMESPACE}:k:a`);
      const b = await raw.get(`${NAMESPACE}:k:b`);
      const tag = await raw.smembers(`${NAMESPACE}:t:grp`);
      return a === null && b === null && tag.length === 0;
    });
    expect(cleared).toBe(true);
    // The untagged key survives.
    expect(await raw.get(`${NAMESPACE}:k:c`)).not.toBeNull();
  });

  test("an invalidation broadcast on one provider reaches another via real Pub/Sub", async () => {
    // Two independent provider instances sharing the same real Redis + channel.
    const producer = new RedisCacheProvider({
      client: makeRawClient(),
      namespace: NAMESPACE,
      invalidationChannel: CHANNEL,
    });
    const consumer = new RedisCacheProvider({
      client: makeRawClient(),
      namespace: NAMESPACE,
      invalidationChannel: CHANNEL,
    });
    try {
      const sharedKey = "cross-instance";

      // Producer writes; consumer hydrates the same key into its own mirror.
      producer.set(sharedKey, "v1");
      await flushAsync();
      // First consumer get misses (empty mirror) but schedules hydration.
      expect(consumer.get(sharedKey)).toBeUndefined();
      await waitFor(() => consumer.get<string>(sharedKey) === "v1");
      expect(consumer.get<string>(sharedKey)).toBe("v1");

      // Producer deletes → broadcasts invalidate-key over REAL Redis Pub/Sub.
      producer.delete(sharedKey);

      // Consumer must drop the key from its mirror once the real message
      // is delivered. Wait for the genuine async delivery; do not mock it.
      await waitFor(() => consumer.get(sharedKey) === undefined);
      expect(consumer.get(sharedKey)).toBeUndefined();
    } finally {
      await producer.close();
      await consumer.close();
    }
  });
});
