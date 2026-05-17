/**
 * RedisInvalidator tests — verify the Pub/Sub round-trip between two
 * provider instances using a shared broker.
 */

import { describe, expect, it } from "bun:test";
import { RedisCacheProvider } from "../src/redis-cache-provider";
import { RedisInvalidator } from "../src/redis-invalidator";
import { MockRedis, makeLinkedMockPair } from "./mock-redis";

const CHANNEL = "test:cache:invalidate";

async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RedisInvalidator", () => {
  it("publishes a serialised message on the configured channel", async () => {
    const pub = new MockRedis();
    const sub = pub.duplicate() as MockRedis;
    const received: unknown[] = [];

    const invalidator = new RedisInvalidator({
      publisher: pub,
      subscriber: sub,
      channel: CHANNEL,
      onMessage: (msg) => received.push(msg),
    });

    await invalidator.start();
    await invalidator.broadcast({ type: "invalidate-key", key: "foo", origin: invalidator.id });
    await flushAsync();

    const pubs = pub.commandsByName("PUBLISH");
    expect(pubs.length).toBe(1);
    const pubCmd = pubs[0];
    if (!pubCmd) throw new Error("PUBLISH missing");
    expect(pubCmd.args[0]).toBe(CHANNEL);
    const decoded = JSON.parse(pubCmd.args[1] as string);
    expect(decoded.type).toBe("invalidate-key");

    await invalidator.stop();
  });

  it("ignores invalid JSON payloads without throwing", async () => {
    const pub = new MockRedis();
    const sub = pub.duplicate() as MockRedis;
    const received: unknown[] = [];
    const errors: string[] = [];

    const invalidator = new RedisInvalidator({
      publisher: pub,
      subscriber: sub,
      channel: CHANNEL,
      onMessage: (msg) => received.push(msg),
      logger: {
        error: (msg) => errors.push(msg),
      },
    });

    await invalidator.start();
    // Inject a malformed message directly through the broker.
    sub._deliver(CHANNEL, "not-json");
    await flushAsync();

    expect(received.length).toBe(0);
    expect(errors.some((e) => e.includes("invalid JSON"))).toBe(true);

    await invalidator.stop();
  });

  it("propagates invalidation across two RedisCacheProvider instances", async () => {
    const { a, b } = makeLinkedMockPair();

    const providerA = new RedisCacheProvider({
      client: a,
      namespace: "test",
      invalidationChannel: CHANNEL,
    });
    const providerB = new RedisCacheProvider({
      client: b,
      namespace: "test",
      invalidationChannel: CHANNEL,
    });

    await flushAsync();

    // Both providers have the same key in their local mirrors.
    providerA.set("shared", "v", { tags: ["t1"] });
    providerB.set("shared", "v", { tags: ["t1"] });
    expect(providerA.get<string>("shared")).toBe("v");
    expect(providerB.get<string>("shared")).toBe("v");

    // A publishes an invalidate-key broadcast; B should evict from its mirror.
    providerA.delete("shared");
    await flushAsync();
    expect(providerB.get("shared")).toBeUndefined();

    // Tag invalidation broadcast — re-seed and try the tag path.
    providerA.set("k", 1, { tags: ["tag-x"] });
    providerB.set("k", 1, { tags: ["tag-x"] });
    await flushAsync();
    providerA.invalidateByTag("tag-x");
    await flushAsync();
    expect(providerB.get("k")).toBeUndefined();

    await providerA.close();
    await providerB.close();
  });
});
