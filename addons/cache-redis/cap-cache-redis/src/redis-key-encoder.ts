/**
 * Key + value encoders for the Redis cache provider.
 *
 * - Every logical key is prefixed with `{namespace}:k:` to keep cache values,
 *   tag indexes, and other Redis traffic from colliding.
 * - Tag indexes live under `{namespace}:t:{tag}` and contain the *raw*
 *   (un-prefixed) keys that carry the tag — this makes invalidateByTag a
 *   single SMEMBERS + DEL round-trip.
 * - Values are wrapped in a JSON envelope that carries the original payload
 *   plus TTL/SWR metadata so the L1 contract (getWithStaleness) can be
 *   honoured without relying on Redis-side metadata.
 */

import type { EncodedCacheEnvelope } from "./types";

export const DEFAULT_NAMESPACE = "linchkit:cache";
export const DEFAULT_INVALIDATION_CHANNEL = "linchkit:cache:invalidate";

export class RedisKeyEncoder {
  constructor(public readonly namespace: string = DEFAULT_NAMESPACE) {
    if (!namespace) {
      throw new Error("Redis cache namespace must not be empty");
    }
  }

  /** Encode a logical key into the Redis key used to store the envelope. */
  valueKey(key: string): string {
    return `${this.namespace}:k:${key}`;
  }

  /** Encode a tag name into the Redis key used to store the tag's member set. */
  tagKey(tag: string): string {
    return `${this.namespace}:t:${tag}`;
  }

  /** Glob pattern matching every value key in this namespace. */
  valueKeyPattern(): string {
    return `${this.namespace}:k:*`;
  }

  /** Glob pattern matching every value key beginning with `prefix`. */
  valueKeyPatternForPrefix(prefix: string): string {
    return `${this.namespace}:k:${prefix}*`;
  }

  /** Convert a Redis key back into its logical form. Returns null if it is not a value key. */
  fromValueKey(redisKey: string): string | null {
    const prefix = `${this.namespace}:k:`;
    return redisKey.startsWith(prefix) ? redisKey.slice(prefix.length) : null;
  }
}

/** Serialise an envelope for storage in Redis. */
export function encodeEnvelope(envelope: EncodedCacheEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parse a stored envelope. Returns null when the payload is missing or
 * structurally invalid — callers should treat that as a cache miss rather
 * than throw, so a poisoned key never breaks reads.
 */
export function decodeEnvelope(raw: string | null): EncodedCacheEnvelope | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as EncodedCacheEnvelope;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { t?: unknown }).t)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
