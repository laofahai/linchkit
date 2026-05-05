/**
 * Action idempotency cache key — behavior-affecting meta inclusion (Spec 65 §5).
 *
 * The idempotency cache must include behavior-affecting meta (e.g. `dry_run`,
 * `skip_notifications`, `bulk`, `default.*`) so two requests with the same
 * idempotency key but different behavior-affecting meta are treated as
 * different operations. Observational meta (`lang`, `tz`, `source_view`,
 * `_`-prefixed system keys) must NOT fragment the cache.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import {
  BEHAVIOR_AFFECTING_META_KEYS,
  extractBehaviorAffectingMeta,
  hashBehaviorAffectingMeta,
  isBehaviorAffectingMetaKey,
} from "../src/engine/meta-keys";
import { InMemoryExecutionLogger } from "../src/observability/execution-logger";
import type { ActionDefinition, Actor } from "../src/types/action";

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

function createMockDataProvider(): DataProvider {
  return {
    get: async () => ({}),
    query: async () => [],
    create: async (_schema, data) => ({ id: "id_1", ...data }),
    update: async (_schema, id, data) => ({ id, ...data }),
    delete: async () => {},
    count: async () => 0,
  };
}

// Action whose handler increments a counter — lets tests assert cache hit vs miss.
function makeCountingAction(state: { calls: number; lastMeta: Record<string, unknown> | null }) {
  const action: ActionDefinition = {
    name: "count_call",
    entity: "order",
    label: "Count Call",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      state.calls += 1;
      state.lastMeta = ctx.meta.toJSON();
      return { calls: state.calls };
    },
  };
  return action;
}

describe("meta-keys utility", () => {
  it("isBehaviorAffectingMetaKey: well-known keys", () => {
    for (const k of BEHAVIOR_AFFECTING_META_KEYS) {
      expect(isBehaviorAffectingMetaKey(k)).toBe(true);
    }
  });

  it("isBehaviorAffectingMetaKey: default.* prefix matches", () => {
    expect(isBehaviorAffectingMetaKey("default.department_id")).toBe(true);
    expect(isBehaviorAffectingMetaKey("default.region")).toBe(true);
  });

  it("isBehaviorAffectingMetaKey: observational and system keys excluded", () => {
    expect(isBehaviorAffectingMetaKey("lang")).toBe(false);
    expect(isBehaviorAffectingMetaKey("tz")).toBe(false);
    expect(isBehaviorAffectingMetaKey("source_view")).toBe(false);
    expect(isBehaviorAffectingMetaKey("triggered_by")).toBe(false);
    expect(isBehaviorAffectingMetaKey("trace_context")).toBe(false);
    expect(isBehaviorAffectingMetaKey("_channel")).toBe(false);
    expect(isBehaviorAffectingMetaKey("_execution_id")).toBe(false);
  });

  it("extractBehaviorAffectingMeta: returns sorted subset only", () => {
    const out = extractBehaviorAffectingMeta({
      bulk: true,
      lang: "zh",
      dry_run: false,
      _channel: "http",
      "default.region": "us",
    });
    expect(Object.keys(out)).toEqual(["bulk", "default.region", "dry_run"]);
    expect(out.bulk).toBe(true);
    expect(out.dry_run).toBe(false);
    expect(out["default.region"]).toBe("us");
  });

  it("hashBehaviorAffectingMeta: stable across key order", () => {
    const a = hashBehaviorAffectingMeta({ dry_run: true, bulk: false });
    const b = hashBehaviorAffectingMeta({ bulk: false, dry_run: true });
    expect(a).toBe(b);
    expect(a).toHaveLength(8);
  });

  it("hashBehaviorAffectingMeta: built-in types (Date, URL, Map) keep their identity in the hash", () => {
    // Regression for CodeRabbit P1: canonicalize used to convert all object
    // values to a sorted POJO, which collapses Date/URL/Map/Set/class
    // instances to {} and makes distinct payloads hash equal.
    const a = hashBehaviorAffectingMeta({
      "default.when": new Date("2026-01-01T00:00:00Z"),
    });
    const b = hashBehaviorAffectingMeta({
      "default.when": new Date("2026-12-31T00:00:00Z"),
    });
    expect(a).not.toBe(b);

    const u1 = hashBehaviorAffectingMeta({ "default.endpoint": new URL("https://a.example") });
    const u2 = hashBehaviorAffectingMeta({ "default.endpoint": new URL("https://b.example") });
    expect(u1).not.toBe(u2);
  });

  it("hashBehaviorAffectingMeta: object-valued payloads canonicalize across property order", () => {
    // Object-valued behavior-affecting keys (e.g. nested `default.config`)
    // must hash the same regardless of property insertion order.
    const a = hashBehaviorAffectingMeta({
      "default.config": { region: "us", retries: 3 },
    });
    const b = hashBehaviorAffectingMeta({
      "default.config": { retries: 3, region: "us" },
    });
    expect(a).toBe(b);

    const c = hashBehaviorAffectingMeta({
      "default.config": { region: "us", retries: 3, nested: { a: 1, b: 2 } },
    });
    const d = hashBehaviorAffectingMeta({
      "default.config": { nested: { b: 2, a: 1 }, retries: 3, region: "us" },
    });
    expect(c).toBe(d);

    // Differing values must still differ
    const e = hashBehaviorAffectingMeta({ "default.config": { region: "eu" } });
    expect(e).not.toBe(a);
  });

  it("hashBehaviorAffectingMeta: empty / observational-only -> empty string", () => {
    expect(hashBehaviorAffectingMeta(undefined)).toBe("");
    expect(hashBehaviorAffectingMeta({})).toBe("");
    expect(hashBehaviorAffectingMeta({ lang: "zh", _channel: "http" })).toBe("");
  });

  it("hashBehaviorAffectingMeta: different value -> different hash", () => {
    const a = hashBehaviorAffectingMeta({ dry_run: true });
    const b = hashBehaviorAffectingMeta({ dry_run: false });
    expect(a).not.toBe(b);
  });
});

describe("ActionExecutor idempotency — behavior-affecting meta", () => {
  let state: { calls: number; lastMeta: Record<string, unknown> | null };
  let logger: InMemoryExecutionLogger;
  let executor: ReturnType<typeof createActionExecutor>;

  beforeEach(() => {
    state = { calls: 0, lastMeta: null };
    logger = new InMemoryExecutionLogger();
    executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });
    executor.registry.register(makeCountingAction(state));
  });

  it("same idempotencyKey + same meta -> cache hit (handler runs once)", async () => {
    const opts = {
      idempotencyKey: "k-1",
      meta: { dry_run: true, lang: "zh" },
    };

    const r1 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, opts);
    const r2 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, opts);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(state.calls).toBe(1); // second call short-circuits to cached output
    expect(r1.executionId).toBe(r2.executionId);
    expect(r2.data.calls).toBe(1);
  });

  it("same idempotencyKey + different dry_run -> cache miss (handler runs twice)", async () => {
    const r1 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-2",
      meta: { dry_run: true },
    });
    const r2 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-2",
      meta: { dry_run: false },
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(state.calls).toBe(2);
    expect(r1.executionId).not.toBe(r2.executionId);
  });

  it("same idempotencyKey + different lang (observational) -> cache hit", async () => {
    const r1 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-3",
      meta: { lang: "zh" },
    });
    const r2 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-3",
      meta: { lang: "en" },
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(state.calls).toBe(1);
    expect(r1.executionId).toBe(r2.executionId);
  });

  it("same idempotencyKey + different default.department_id -> cache miss", async () => {
    const r1 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-4",
      meta: { "default.department_id": "dept-a" },
    });
    const r2 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-4",
      meta: { "default.department_id": "dept-b" },
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(state.calls).toBe(2);
    expect(r1.executionId).not.toBe(r2.executionId);
  });

  it("rollout fallback: meta-suffixed miss honors a legacy un-suffixed entry whose meta matches", async () => {
    // Simulate an entry written before this change at the bare key, with the
    // SAME behavior-affecting meta the retry will send. This is the rollout
    // case the fallback exists for: a client retries the same operation
    // across a deploy boundary, and we honor the original execution rather
    // than re-running.
    const baseKey = "count_call::k-legacy";
    await logger.log({
      id: "exec-legacy",
      action: "count_call",
      actor: defaultActor,
      input: {},
      output: { calls: 99 },
      status: "succeeded",
      idempotencyKey: baseKey, // pre-rollout shape (no `:m:<hash>` suffix)
      meta: { dry_run: true }, // behavior-affecting subset matches the retry
      duration: 0,
      startedAt: new Date(),
    });

    const r = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-legacy",
      meta: { dry_run: true },
    });

    expect(r.success).toBe(true);
    expect(r.executionId).toBe("exec-legacy");
    expect(state.calls).toBe(0); // handler did not run — legacy entry honored
  });

  it("user-provided idempotencyKey containing `:m:` cannot collide with a hashed suffix", async () => {
    // Regression for gemini security-high (PR #227 review): without
    // escaping the rawKey, an attacker passing `K:m:<hash>` with empty
    // meta would compute the same effective cache key as a victim's
    // legitimate request `K + meta-that-hashes-to-<hash>`. The 32-bit
    // hash is brute-forceable, so this would let one caller read or
    // poison another's cached output. After percent-encoding `:` and
    // `%` in the rawKey, the two effective keys are distinct.
    const r1 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "victim",
      meta: { dry_run: true },
    });
    const attackerKey = `victim:m:${hashBehaviorAffectingMeta({ dry_run: true })}`;
    const r2 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: attackerKey,
      // No behavior-affecting meta — without the escape, this would have
      // hit r1's cache.
      meta: { lang: "zh" },
    });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Critical assertion: attacker did NOT get the victim's cached
    // execution id, and the handler ran twice (no spurious cache hit).
    expect(r2.executionId).not.toBe(r1.executionId);
    expect(state.calls).toBe(2);
  });

  it("rollout fallback: legacy bare-key entry with DIFFERENT meta is NOT honored", async () => {
    // Regression for CodeRabbit P1: the rollout fallback used to return ANY
    // bare-key entry it found. That's wrong — a legacy entry written under
    // empty meta would mask a semantically-different retry that arrives with
    // dry_run/default.* set. The fallback must compare the stored entry's
    // behavior-affecting subset to the current request's and only honor a
    // match.
    const baseKey = "count_call::k-different-meta";
    await logger.log({
      id: "exec-empty-meta",
      action: "count_call",
      actor: defaultActor,
      input: {},
      output: { calls: 99 },
      status: "succeeded",
      idempotencyKey: baseKey, // bare key (no `:m:<hash>` suffix)
      meta: { lang: "zh" }, // observational only — behavior-affecting subset is empty
      duration: 0,
      startedAt: new Date(),
    });

    const r = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-different-meta",
      meta: { dry_run: true }, // behavior-affecting — different operation
    });

    expect(r.success).toBe(true);
    expect(r.executionId).not.toBe("exec-empty-meta"); // re-executed
    expect(state.calls).toBe(1);
  });

  it("idempotency key + meta hash exceeding 255 characters fails fast before the handler runs", async () => {
    // Construct a raw idempotency key long enough that the suffixed effective
    // key exceeds the varchar(255) column (counted in codepoints, not UTF-16
    // code units). The check must fire BEFORE the handler runs so callers
    // can't end up with a committed mutation + a persistence failure that
    // would surface as a false negative.
    const longRawKey = "x".repeat(255);
    const r = await executor.execute<{ error: string; code?: string }>(
      "count_call",
      {},
      defaultActor,
      {
        idempotencyKey: longRawKey,
        meta: { dry_run: true },
      },
    );

    expect(r.success).toBe(false);
    expect(r.data.code).toBe("core.action.idempotency_key_too_long");
    expect(state.calls).toBe(0); // handler did not run
  });

  it("_-prefixed keys are not hashed (system keys cause no cache fragmentation)", async () => {
    // The engine strips client-supplied `_`-prefixed keys at the trust boundary,
    // and they're explicitly excluded from the behavior-affecting set. Two calls
    // with the same key + same behavior-affecting meta must hit the cache even
    // when callers attempt to vary `_channel`, `_source_action`, etc.
    const r1 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-5",
      meta: { _channel: "http", _source_action: "ignored" },
    });
    const r2 = await executor.execute<{ calls: number }>("count_call", {}, defaultActor, {
      idempotencyKey: "k-5",
      meta: { _channel: "internal", _source_action: "different" },
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(state.calls).toBe(1);
    expect(r1.executionId).toBe(r2.executionId);
  });
});
