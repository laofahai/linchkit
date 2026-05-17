/**
 * @linchkit/cap-cache-redis — public API
 *
 * Exports the Redis L2 cache provider, the Pub/Sub-based cross-instance
 * invalidator, and the capability factory used by host applications.
 */

export { type CapCacheRedisOptions, capCacheRedis, createCapCacheRedis } from "./capability";
export {
  createRedisCacheProvider,
  RedisCacheProvider,
} from "./redis-cache-provider";
export { RedisInvalidator, type RedisInvalidatorOptions } from "./redis-invalidator";
export {
  DEFAULT_INVALIDATION_CHANNEL,
  DEFAULT_NAMESPACE,
  decodeEnvelope,
  encodeEnvelope,
  RedisKeyEncoder,
} from "./redis-key-encoder";
export type {
  EncodedCacheEnvelope,
  InvalidationMessage,
  RedisCacheProviderOptions,
  RedisClientFactory,
  RedisLike,
} from "./types";
