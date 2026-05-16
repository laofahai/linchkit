/**
 * Public types for @linchkit/cap-cache-redis.
 *
 * The Redis cache provider acts as the L2 layer in a multi-tier CacheManager
 * (L1 = in-process, L2 = Redis, L3 = Postgres). It also ships a companion
 * RedisInvalidator that broadcasts cross-instance invalidation events via
 * Redis Pub/Sub so each instance's L1 can be cleared in lock-step with L2.
 */

/** Minimal Redis client surface this provider depends on. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, ...args: unknown[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  duplicate(overrides?: Record<string, unknown>): RedisLike;
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): unknown;
}

/** Factory signature for constructing a Redis-like client. */
export type RedisClientFactory = (urlOrOptions: string | Record<string, unknown>) => RedisLike;

/** Options accepted by createRedisCacheProvider and the capability factory. */
export interface RedisCacheProviderOptions {
  /**
   * Redis connection URL (e.g. `redis://user:pass@host:6379/0`).
   * Mutually exclusive with `client`. When omitted the provider falls back
   * to `process.env.REDIS_URL`.
   */
  redisUrl?: string;
  /**
   * Pre-constructed Redis client. Useful for tests or when the host
   * application wants to share a single connection pool.
   */
  client?: RedisLike;
  /**
   * Key namespace prepended to every Redis key.
   * @default "linchkit:cache"
   */
  namespace?: string;
  /**
   * Channel name used by RedisInvalidator. Different deployments can
   * isolate their invalidation traffic by overriding this.
   * @default "linchkit:cache:invalidate"
   */
  invalidationChannel?: string;
  /**
   * Override factory for testing — when provided it replaces the default
   * `ioredis` import path.
   */
  clientFactory?: RedisClientFactory;
  /** Optional logger for debug/error output. Defaults to no-op. */
  logger?: {
    debug?: (msg: string) => void;
    error?: (msg: string, err?: unknown) => void;
  };
}

/** Wire format for invalidation messages broadcast over Pub/Sub. */
export type InvalidationMessage =
  | { type: "invalidate-key"; key: string; origin: string }
  | { type: "invalidate-tag"; tag: string; origin: string }
  | { type: "invalidate-prefix"; prefix: string; origin: string }
  | { type: "clear"; origin: string };

/** Encoded value stored at every cache key. */
export interface EncodedCacheEnvelope {
  /** The original payload, JSON serialised. */
  v: unknown;
  /** Hard expiry timestamp (ms since epoch). Omitted = no hard TTL. */
  e?: number;
  /** Soft expiry timestamp (ms since epoch) for stale-while-revalidate. */
  s?: number;
  /** Tags attached at write time. */
  t: string[];
  /** Creation timestamp (ms since epoch). */
  c: number;
}
