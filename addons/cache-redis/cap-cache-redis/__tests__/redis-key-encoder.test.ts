/**
 * Tests for the Redis key encoder and envelope helpers.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_INVALIDATION_CHANNEL,
  DEFAULT_NAMESPACE,
  decodeEnvelope,
  encodeEnvelope,
  RedisKeyEncoder,
} from "../src/redis-key-encoder";

describe("RedisKeyEncoder", () => {
  it("uses the default namespace", () => {
    const encoder = new RedisKeyEncoder();
    expect(encoder.namespace).toBe(DEFAULT_NAMESPACE);
    expect(encoder.valueKey("foo")).toBe(`${DEFAULT_NAMESPACE}:k:foo`);
    expect(encoder.tagKey("orders")).toBe(`${DEFAULT_NAMESPACE}:t:orders`);
  });

  it("honours custom namespaces", () => {
    const encoder = new RedisKeyEncoder("custom");
    expect(encoder.valueKey("foo")).toBe("custom:k:foo");
    expect(encoder.tagKey("t1")).toBe("custom:t:t1");
    expect(encoder.valueKeyPattern()).toBe("custom:k:*");
    expect(encoder.valueKeyPatternForPrefix("user:")).toBe("custom:k:user:*");
  });

  it("rejects empty namespaces", () => {
    expect(() => new RedisKeyEncoder("")).toThrow();
  });

  it("decodes value keys back to logical keys", () => {
    const encoder = new RedisKeyEncoder();
    const redisKey = encoder.valueKey("user:42");
    expect(encoder.fromValueKey(redisKey)).toBe("user:42");
    expect(encoder.fromValueKey("other:k:nope")).toBeNull();
  });

  it("exposes the default invalidation channel constant", () => {
    expect(DEFAULT_INVALIDATION_CHANNEL).toBe("linchkit:cache:invalidate");
  });
});

describe("envelope codec", () => {
  it("round-trips an envelope", () => {
    const now = Date.now();
    const encoded = encodeEnvelope({
      v: { hello: "world" },
      e: now + 60_000,
      s: now + 30_000,
      t: ["tenant:t1"],
      c: now,
    });
    const decoded = decodeEnvelope(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.v).toEqual({ hello: "world" });
    expect(decoded?.t).toEqual(["tenant:t1"]);
    expect(decoded?.e).toBe(now + 60_000);
    expect(decoded?.s).toBe(now + 30_000);
    expect(decoded?.c).toBe(now);
  });

  it("returns null on missing or malformed input", () => {
    expect(decodeEnvelope(null)).toBeNull();
    expect(decodeEnvelope("not-json")).toBeNull();
    expect(decodeEnvelope("{}")).toBeNull(); // tags missing
    expect(decodeEnvelope('{"t":"oops"}')).toBeNull(); // tags wrong type
  });
});
