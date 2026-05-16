/**
 * RedisCacheProvider — L2 distributed cache backed by Redis.
 *
 * Implementation notes
 * --------------------
 * The core `CacheProvider` interface is intentionally synchronous so the L1
 * fast path can stay zero-latency. Redis itself is asynchronous, so this
 * provider keeps a small process-local mirror (`localMirror`) that answers
 * `get` / `getWithStaleness` immediately. Every successful `set` writes both
 * to Redis (best-effort, fire-and-forget with logged failures) and to the
 * mirror so subsequent `get` calls on the same instance see the value
 * without an extra round-trip.
 *
 * Cross-instance consistency is delivered by `RedisInvalidator`, which
 * publishes invalidation messages on a Pub/Sub channel that every other
 * provider instance subscribes to. Listeners wipe the matching entry from
 * the mirror (and, when wired into a CacheManager, the L1 cache as well).
 *
 * TTL + SWR
 * ---------
 * Hard expiry is enforced by Redis via the `PX` (millisecond) option on
 * `SET`, and locally by comparing `Date.now()` to the envelope's
 * `expiresAt`. SWR is purely metadata — we store both `softExpiresAt` and
 * `expiresAt` in the envelope, then on read decide whether the value is
 * fresh, stale-but-serveable, or hard-expired (treat as miss).
 *
 * Tags
 * ----
 * Each tag maps to a Redis set at `{namespace}:t:{tag}` whose members are
 * the raw (un-prefixed) keys carrying the tag. `invalidateByTag` runs
 * SMEMBERS to enumerate keys, deletes the underlying value keys with a
 * single DEL, then deletes the tag set itself.
 */

import { createRequire } from "node:module";
import type { CacheProvider, CacheSetOptions, CacheStats } from "@linchkit/core";
import { RedisInvalidator } from "./redis-invalidator";
import {
  DEFAULT_INVALIDATION_CHANNEL,
  DEFAULT_NAMESPACE,
  decodeEnvelope,
  encodeEnvelope,
  RedisKeyEncoder,
} from "./redis-key-encoder";
import type {
  EncodedCacheEnvelope,
  InvalidationMessage,
  RedisCacheProviderOptions,
  RedisLike,
} from "./types";

const noopLogger = {
  debug: (_msg: string) => {
    // intentionally empty
  },
  error: (_msg: string, _err?: unknown) => {
    // intentionally empty
  },
};

type LocalEntry = {
  value: unknown;
  expiresAt?: number;
  softExpiresAt?: number;
  tags: string[];
};

export class RedisCacheProvider implements CacheProvider {
  private readonly client: RedisLike;
  private readonly encoder: RedisKeyEncoder;
  private readonly invalidator: RedisInvalidator;
  private readonly logger: {
    debug: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };
  private readonly localMirror = new Map<string, LocalEntry>();

  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(options: RedisCacheProviderOptions = {}) {
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.encoder = new RedisKeyEncoder(namespace);
    this.logger = {
      debug: options.logger?.debug ?? noopLogger.debug,
      error: options.logger?.error ?? noopLogger.error,
    };

    this.client = resolveClient(options);

    this.invalidator = new RedisInvalidator({
      publisher: this.client,
      subscriber: this.client.duplicate(),
      channel: options.invalidationChannel ?? DEFAULT_INVALIDATION_CHANNEL,
      logger: this.logger,
      onMessage: (msg) => this.handleInvalidation(msg),
    });

    // Begin subscribing eagerly — failures are logged but never thrown so
    // construction stays synchronous and matches the L1 provider's contract.
    void this.invalidator.start().catch((err) => {
      this.logger.error("[RedisCacheProvider] Failed to start invalidator", err);
    });
  }

  // ── Reads ───────────────────────────────────────────────

  get<T = unknown>(key: string): T | undefined {
    return this.getWithStaleness<T>(key)?.value;
  }

  getWithStaleness<T = unknown>(key: string): { value: T; isStale: boolean } | undefined {
    const entry = this.localMirror.get(key);
    if (!entry) {
      this._misses++;
      // Schedule a best-effort Redis hydration so the next call hits the mirror.
      void this.hydrateFromRedis(key).catch((err) => {
        this.logger.error(`[RedisCacheProvider] hydrate failed for ${key}`, err);
      });
      return undefined;
    }

    const now = Date.now();
    if (entry.expiresAt !== undefined && now > entry.expiresAt) {
      this.localMirror.delete(key);
      this._evictions++;
      this._misses++;
      return undefined;
    }

    this._hits++;
    const isStale = entry.softExpiresAt !== undefined && now > entry.softExpiresAt;
    return { value: entry.value as T, isStale };
  }

  // ── Writes ──────────────────────────────────────────────

  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): void {
    const now = Date.now();
    const tags = options?.tags ?? [];

    let softExpiresAt: number | undefined;
    let hardExpiresAt: number | undefined;
    let pxMillis: number | undefined;

    if (options?.ttl !== undefined) {
      if (options.swrTtl !== undefined) {
        softExpiresAt = now + options.ttl;
        hardExpiresAt = now + options.ttl + options.swrTtl;
        pxMillis = options.ttl + options.swrTtl;
      } else {
        hardExpiresAt = now + options.ttl;
        pxMillis = options.ttl;
      }
    }

    const envelope: EncodedCacheEnvelope = {
      v: value,
      e: hardExpiresAt,
      s: softExpiresAt,
      t: tags,
      c: now,
    };

    this.localMirror.set(key, {
      value,
      expiresAt: hardExpiresAt,
      softExpiresAt,
      tags,
    });

    void this.writeToRedis(key, envelope, pxMillis, tags).catch((err) => {
      this.logger.error(`[RedisCacheProvider] SET failed for ${key}`, err);
    });
  }

  delete(key: string): boolean {
    const existed = this.localMirror.delete(key);
    void this.deleteFromRedis(key).catch((err) => {
      this.logger.error(`[RedisCacheProvider] DEL failed for ${key}`, err);
    });
    void this.invalidator
      .broadcast({ type: "invalidate-key", key, origin: this.invalidator.id })
      .catch((err) => {
        this.logger.error(`[RedisCacheProvider] PUBLISH delete failed for ${key}`, err);
      });
    return existed;
  }

  invalidateByTag(tag: string): number {
    let count = 0;
    for (const [key, entry] of this.localMirror) {
      if (entry.tags.includes(tag)) {
        this.localMirror.delete(key);
        count++;
      }
    }

    void this.invalidateTagInRedis(tag).catch((err) => {
      this.logger.error(`[RedisCacheProvider] tag invalidate failed for ${tag}`, err);
    });
    void this.invalidator
      .broadcast({ type: "invalidate-tag", tag, origin: this.invalidator.id })
      .catch((err) => {
        this.logger.error(`[RedisCacheProvider] PUBLISH tag failed for ${tag}`, err);
      });
    return count;
  }

  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of [...this.localMirror.keys()]) {
      if (key.startsWith(prefix)) {
        this.localMirror.delete(key);
        count++;
      }
    }
    void this.invalidator
      .broadcast({ type: "invalidate-prefix", prefix, origin: this.invalidator.id })
      .catch((err) => {
        this.logger.error(`[RedisCacheProvider] PUBLISH prefix failed for ${prefix}`, err);
      });
    return count;
  }

  clear(): void {
    this.localMirror.clear();
    void this.invalidator.broadcast({ type: "clear", origin: this.invalidator.id }).catch((err) => {
      this.logger.error("[RedisCacheProvider] PUBLISH clear failed", err);
    });
  }

  stats(): CacheStats {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      size: this.localMirror.size,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }

  /** Gracefully release the underlying Redis connections. */
  async close(): Promise<void> {
    await this.invalidator.stop();
    try {
      await this.client.quit();
    } catch (err) {
      this.logger.error("[RedisCacheProvider] quit failed", err);
    }
  }

  // ── Internal helpers ────────────────────────────────────

  private async writeToRedis(
    key: string,
    envelope: EncodedCacheEnvelope,
    pxMillis: number | undefined,
    tags: string[],
  ): Promise<void> {
    const redisKey = this.encoder.valueKey(key);
    const payload = encodeEnvelope(envelope);
    if (pxMillis !== undefined) {
      await this.client.set(redisKey, payload, "PX", pxMillis);
    } else {
      await this.client.set(redisKey, payload);
    }
    for (const tag of tags) {
      await this.client.sadd(this.encoder.tagKey(tag), key);
    }
  }

  private async deleteFromRedis(key: string): Promise<void> {
    await this.client.del(this.encoder.valueKey(key));
  }

  private async invalidateTagInRedis(tag: string): Promise<void> {
    const tagKey = this.encoder.tagKey(tag);
    const members = await this.client.smembers(tagKey);
    if (members.length > 0) {
      const redisKeys = members.map((m) => this.encoder.valueKey(m));
      await this.client.del(...redisKeys);
    }
    await this.client.del(tagKey);
  }

  private async hydrateFromRedis(key: string): Promise<void> {
    const raw = await this.client.get(this.encoder.valueKey(key));
    const envelope = decodeEnvelope(raw);
    if (!envelope) return;
    const now = Date.now();
    if (envelope.e !== undefined && now > envelope.e) {
      // Already hard-expired upstream — best-effort cleanup.
      await this.client.del(this.encoder.valueKey(key));
      return;
    }
    this.localMirror.set(key, {
      value: envelope.v,
      expiresAt: envelope.e,
      softExpiresAt: envelope.s,
      tags: envelope.t,
    });
  }

  private handleInvalidation(msg: InvalidationMessage): void {
    // Ignore our own broadcasts to avoid double-evicting on the publisher.
    if ("origin" in msg && msg.origin === this.invalidator.id) return;

    switch (msg.type) {
      case "invalidate-key":
        this.localMirror.delete(msg.key);
        break;
      case "invalidate-tag": {
        for (const [k, entry] of this.localMirror) {
          if (entry.tags.includes(msg.tag)) this.localMirror.delete(k);
        }
        break;
      }
      case "invalidate-prefix": {
        for (const k of [...this.localMirror.keys()]) {
          if (k.startsWith(msg.prefix)) this.localMirror.delete(k);
        }
        break;
      }
      case "clear":
        this.localMirror.clear();
        break;
    }
  }
}

/**
 * Resolve a Redis client from constructor options.
 *
 * Priority: explicit `client` > custom `clientFactory` > default `ioredis`
 * import driven by `redisUrl` (or REDIS_URL env var).
 */
function resolveClient(options: RedisCacheProviderOptions): RedisLike {
  if (options.client) return options.client;

  const url = options.redisUrl ?? process.env.REDIS_URL;
  if (!url && !options.clientFactory) {
    throw new Error(
      "RedisCacheProvider requires `redisUrl`, REDIS_URL env, or an explicit `client`/`clientFactory`",
    );
  }

  if (options.clientFactory) {
    return options.clientFactory(url ?? "");
  }

  // Default path: dynamically require ioredis so tests can construct the
  // provider with a mock client and avoid bundling the real driver.
  const req = createRequire(import.meta.url);
  // biome-ignore lint/suspicious/noExplicitAny: ioredis exports vary between CJS/ESM
  const required: any = req("ioredis");
  const Ctor = required?.default ?? required;
  return new Ctor(url) as RedisLike;
}

/** Convenience factory mirroring the capability-level helper. */
export function createRedisCacheProvider(options?: RedisCacheProviderOptions): RedisCacheProvider {
  return new RedisCacheProvider(options);
}
