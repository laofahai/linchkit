# @linchkit/cap-cache-redis

Redis-backed L2 cache provider with cross-instance invalidation via Redis
Pub/Sub. Implements the standard `CacheProvider` interface from
`@linchkit/core` so it can slot into `CacheManager` as the L2 layer above an
in-process L1.

## When to use

Reach for this capability when your deployment grows past the
~10-instance threshold where the Postgres LISTEN/NOTIFY invalidator
(`PostgresCacheInvalidator`, Spec 34 §7 Phase 1) starts to cost more
connections than it saves. Redis Pub/Sub fans messages out to every
subscriber in O(1), and the shared L2 store reduces cold-start latency
after deployments.

Stay on Postgres NOTIFY if you have fewer than 10 application instances —
introducing Redis adds an operational dependency the L1+NOTIFY layout does
not need.

## Install

```bash
bun add @linchkit/cap-cache-redis ioredis
```

`ioredis` is a peer-grade runtime dependency. Choose `ioredis` over `redis`
for Sentinel / Cluster compatibility.

## Bootstrap

```ts
import { CacheManager, InMemoryCacheProvider } from "@linchkit/core";
import { createCapCacheRedis } from "@linchkit/cap-cache-redis";

const cacheRedis = createCapCacheRedis({
  redisUrl: process.env.REDIS_URL,
  namespace: "linchkit:cache",          // optional, defaults shown
  invalidationChannel: "linchkit:cache:invalidate",
});

const cacheManager = new CacheManager({
  l1: new InMemoryCacheProvider({ maxSize: 5_000 }),
  l2: cacheRedis.provider,
});

// register the capability with your host so other capabilities can
// resolve the provider via DI.
host.registerCapability(cacheRedis);
```

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `REDIS_URL` | yes (or pass `redisUrl`) | Standard Redis connection URI, e.g. `redis://user:pass@host:6379/0`. Use `rediss://` for TLS. |

## How it works

* **TTL** — `set(key, value, { ttl })` issues `SET key value PX ttl` so
  Redis evicts the entry server-side. The same expiry timestamp is stored
  in a JSON envelope so the local mirror can drop the entry without an
  extra round-trip.
* **Stale-while-revalidate** — `swrTtl` extends the Redis-side `PX` to
  `ttl + swrTtl` and records both `softExpiresAt` and `expiresAt` in the
  envelope. `getWithStaleness` returns `{ value, isStale: true }` when the
  read lands in the SWR window.
* **Tags** — each tag maps to a Redis set at `{namespace}:t:{tag}`.
  `invalidateByTag` runs `SMEMBERS` + a single `DEL` for every member,
  then drops the tag set.
* **Cross-instance invalidation** — every write/delete publishes
  `{type, payload}` on `invalidationChannel`. Every other provider
  instance subscribes via a duplicate connection and evicts the matching
  entry from its local mirror.

See [Spec 34 — Cache Strategy](../../../docs/specs/34_cache_strategy.md)
and [issue #131](https://github.com/laofahai/linchkit/issues/131) for the
full design.

## Limitations

* The local mirror is a write-through cache; a freshly-started instance
  pays one Redis `GET` to hydrate any key it has not seen before.
* Stats (`getStats()`) are per-process — Redis itself does not expose
  per-application hit/miss counters.
