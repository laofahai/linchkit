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

  it("rollout fallback: meta-suffixed miss falls back to legacy un-suffixed entry", async () => {
    // Simulate an entry written before this change (no meta suffix in stored key).
    // The new code probes the suffixed key first and, on miss, falls back to the
    // bare key — so existing successful executions still short-circuit a retry
    // that arrives with behavior-affecting meta after the deployment.
    const baseKey = "count_call::k-legacy";
    await logger.log({
      id: "exec-legacy",
      action: "count_call",
      actor: defaultActor,
      input: {},
      output: { calls: 99 },
      status: "succeeded",
      idempotencyKey: baseKey, // no `:m:<hash>` suffix — pre-rollout shape
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

  it("idempotency key + meta hash exceeding 255 bytes fails fast before the handler runs", async () => {
    // Construct a raw idempotency key long enough that the suffixed effective
    // key exceeds the varchar(255) column. The check must fire BEFORE the
    // handler runs so callers can't end up with a committed mutation + a
    // persistence failure that would surface as a false negative.
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
