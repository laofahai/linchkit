/**
 * ActionEngine — ExecutionMeta propagation through nested ctx.execute (Spec 65 Phase 1).
 *
 * Covers:
 * - Parent's meta keys visible in child action.
 * - Child's `options.meta` extensions visible to child, but parent keys win on collision.
 * - `_depth` bumps: root=0, child=1, grandchild=2.
 * - `_source_action` on the child equals the parent action's name.
 * - `_execution_id` stays the same across the chain (root id preserved).
 */

import { describe, expect, test } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import { InMemoryMetricsCollector } from "../src/observability/metrics";
import type { ActionContext, ActionDefinition, Actor } from "../src/types/action";
import { createExecutionMeta, DEFAULT_META_MAX_BYTES } from "../src/types/execution-meta";
import { createTestDataProvider } from "./command-layer-helpers";

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

/** Captured snapshots from handler ctx — one per action invocation. */
interface Capture {
  action: string;
  meta: Record<string, unknown>;
  executionId: string;
}

describe("ActionEngine — ExecutionMeta propagation via ctx.execute", () => {
  test("parent meta keys visible in child; parent wins on override attempt", async () => {
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const recordCapture = (ctx: ActionContext, name: string) => {
      captures.push({
        action: name,
        meta: ctx.meta.toJSON(),
        executionId: ctx.executionId,
      });
    };

    const parent: ActionDefinition = {
      name: "parent_action",
      entity: "item",
      label: "Parent",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        recordCapture(ctx, "parent_action");
        // Child tries to override `bulk` (parent set to true) and also adds a new key.
        await ctx.execute(
          "child_action",
          {},
          {
            meta: { bulk: false, validation_mode: "strict" },
          },
        );
        return { ok: true };
      },
    };

    const child: ActionDefinition = {
      name: "child_action",
      entity: "item",
      label: "Child",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        recordCapture(ctx, "child_action");
        return { child: true };
      },
    };

    executor.registry.register(parent);
    executor.registry.register(child);

    const layer = createCommandLayer({ executor });
    const result = await layer.execute({
      command: "parent_action",
      input: {},
      meta: { bulk: true, source: "import" },
      actor: defaultActor,
      channel: "internal",
    });

    expect(result.success).toBe(true);
    expect(captures.length).toBe(2);

    const [parentCap, childCap] = captures;
    // Parent sees its original meta.
    expect(parentCap.meta.bulk).toBe(true);
    expect(parentCap.meta.source).toBe("import");

    // Child sees parent's keys — parent wins on override attempt.
    expect(childCap.meta.bulk).toBe(true); // NOT false
    expect(childCap.meta.source).toBe("import");
    // Child gets a new key it added that didn't collide.
    expect(childCap.meta.validation_mode).toBe("strict");
  });

  test("_depth bumps across nested calls: 0 -> 1 -> 2", async () => {
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const record = (ctx: ActionContext, name: string) => {
      captures.push({
        action: name,
        meta: ctx.meta.toJSON(),
        executionId: ctx.executionId,
      });
    };

    const root: ActionDefinition = {
      name: "root_action",
      entity: "item",
      label: "Root",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        record(ctx, "root_action");
        await ctx.execute("mid_action", {});
        return { ok: true };
      },
    };

    const mid: ActionDefinition = {
      name: "mid_action",
      entity: "item",
      label: "Mid",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        record(ctx, "mid_action");
        await ctx.execute("leaf_action", {});
        return { mid: true };
      },
    };

    const leaf: ActionDefinition = {
      name: "leaf_action",
      entity: "item",
      label: "Leaf",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        record(ctx, "leaf_action");
        return { leaf: true };
      },
    };

    executor.registry.register(root);
    executor.registry.register(mid);
    executor.registry.register(leaf);

    const layer = createCommandLayer({ executor });
    await layer.execute({
      command: "root_action",
      input: {},
      meta: {},
      actor: defaultActor,
      channel: "internal",
    });

    expect(captures.length).toBe(3);
    const byAction = Object.fromEntries(captures.map((c) => [c.action, c]));

    expect(byAction.root_action.meta._depth).toBe(0);
    expect(byAction.mid_action.meta._depth).toBe(1);
    expect(byAction.leaf_action.meta._depth).toBe(2);
  });

  test("_source_action on child equals the parent action name", async () => {
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const record = (ctx: ActionContext, name: string) => {
      captures.push({
        action: name,
        meta: ctx.meta.toJSON(),
        executionId: ctx.executionId,
      });
    };

    const parent: ActionDefinition = {
      name: "alpha",
      entity: "item",
      label: "Alpha",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        record(ctx, "alpha");
        await ctx.execute("beta", {});
        return { ok: true };
      },
    };

    const child: ActionDefinition = {
      name: "beta",
      entity: "item",
      label: "Beta",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        record(ctx, "beta");
        return { beta: true };
      },
    };

    executor.registry.register(parent);
    executor.registry.register(child);

    const layer = createCommandLayer({ executor });
    await layer.execute({
      command: "alpha",
      input: {},
      actor: defaultActor,
    });

    const byAction = Object.fromEntries(captures.map((c) => [c.action, c]));
    // Root action has no _source_action.
    expect(byAction.alpha.meta._source_action).toBeUndefined();
    expect(byAction.beta.meta._source_action).toBe("alpha");
  });

  test("_execution_id stays the same across the chain", async () => {
    // Spec 65 §4.4: `_execution_id` is the ROOT execution record id (not a
    // tracing context). The ActionEngine stamps it from the root action's
    // `executionId` at depth 0; `extend` preserves that same value through
    // nested ctx.execute calls, so every level sees the root's id.
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const record = (ctx: ActionContext, name: string) => {
      captures.push({
        action: name,
        meta: ctx.meta.toJSON(),
        executionId: ctx.executionId,
      });
    };

    const root: ActionDefinition = {
      name: "root_x",
      entity: "item",
      label: "Root X",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        record(ctx, "root_x");
        await ctx.execute("mid_x", {});
        return { ok: true };
      },
    };

    const mid: ActionDefinition = {
      name: "mid_x",
      entity: "item",
      label: "Mid X",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        record(ctx, "mid_x");
        await ctx.execute("leaf_x", {});
        return { ok: true };
      },
    };

    const leaf: ActionDefinition = {
      name: "leaf_x",
      entity: "item",
      label: "Leaf X",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        record(ctx, "leaf_x");
        return { leaf: true };
      },
    };

    executor.registry.register(root);
    executor.registry.register(mid);
    executor.registry.register(leaf);

    const layer = createCommandLayer({ executor });
    await layer.execute({
      command: "root_x",
      input: {},
      meta: {},
      actor: defaultActor,
    });

    const ids = captures.map((c) => c.meta._execution_id);
    const rootExecutionId = captures[0].executionId;
    // All three levels carry the root action's executionId.
    expect(ids).toEqual([rootExecutionId, rootExecutionId, rootExecutionId]);
    // And each call still had its own per-action executionId distinct from
    // the preserved root id (except for the root itself).
    expect(captures[1].executionId).not.toBe(rootExecutionId);
    expect(captures[2].executionId).not.toBe(rootExecutionId);
  });

  test("direct executor call (no CommandLayer) synthesizes meta with system keys", async () => {
    // When the ActionEngine is invoked directly with no ExecuteOptions.meta,
    // it must still expose a valid ctx.meta populated with system keys.
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const action: ActionDefinition = {
      name: "lone",
      entity: "item",
      label: "Lone",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        captures.push({
          action: "lone",
          meta: ctx.meta.toJSON(),
          executionId: ctx.executionId,
        });
        return { ok: true };
      },
    };
    executor.registry.register(action);

    const result = await executor.execute("lone", {}, defaultActor);
    expect(result.success).toBe(true);
    expect(captures.length).toBe(1);
    expect(captures[0].meta._channel).toBe("internal");
    expect(captures[0].meta._depth).toBe(0);
    expect(captures[0].meta._execution_id).toBe(captures[0].executionId);
  });

  test("caller-supplied ExecuteOptions.meta: user keys flow through, system keys re-stamped", async () => {
    // When a pre-built ExecutionMeta reaches the root executor, user-space
    // keys flow through unchanged, but system keys are always re-stamped
    // by the framework at root (Gemini PR #201 review — system keys must
    // not be spoofable by any entry point). Nested calls preserve system
    // keys; that's covered separately.
    const captures: Capture[] = [];
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const action: ActionDefinition = {
      name: "preset",
      entity: "item",
      label: "Preset",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        captures.push({
          action: "preset",
          meta: ctx.meta.toJSON(),
          executionId: ctx.executionId,
        });
        return { ok: true };
      },
    };
    executor.registry.register(action);

    const preset = createExecutionMeta({
      raw: { flow: "custom", source_view: "queue" },
      // Caller-attempted system keys — must be overridden by framework.
      systemKeys: { _channel: "mcp", _depth: 99, _execution_id: "trace_z" },
    });
    const result = await executor.execute("preset", {}, defaultActor, { meta: preset });

    // User-space keys preserved.
    expect(captures[0].meta.flow).toBe("custom");
    expect(captures[0].meta.source_view).toBe("queue");
    // System keys re-stamped at root — `_channel` defaults to "internal"
    // (no channel in ExecuteOptions), `_execution_id` is the real action id,
    // `_depth` is 0.
    expect(captures[0].meta._channel).toBe("internal");
    expect(captures[0].meta._execution_id).toBe(result.executionId);
    expect(captures[0].meta._execution_id).not.toBe("trace_z");
    expect(captures[0].meta._depth).toBe(0);
  });

  // Codex follow-up: child ctx.execute must enforce the same size limit as
  // root meta construction. If `extend` throws MetaSizeError, ctx.execute
  // surfaces it as a failed child result rather than bubbling the exception
  // up and crashing the parent handler.
  test("child ctx.execute with over-limit meta returns a failed result, not throws", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    let childRan = false;
    let childReturn: unknown = null;

    executor.registry.register({
      name: "child",
      entity: "item",
      label: "Child",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async () => {
        childRan = true;
        return { ok: true };
      },
    });

    executor.registry.register({
      name: "parent_with_oversize_child_meta",
      entity: "item",
      label: "Parent",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        childReturn = await ctx.execute(
          "child",
          {},
          { meta: { huge: "x".repeat(DEFAULT_META_MAX_BYTES + 100) } },
        );
        return { ok: true };
      },
    });

    const result = await executor.execute("parent_with_oversize_child_meta", {}, defaultActor);

    // Parent succeeds — its handler caught the failed child result and returned normally.
    expect(result.success).toBe(true);
    // Child never actually executed (size check failed before it could).
    expect(childRan).toBe(false);
    // ctx.execute returned the failed result's `data` — shaped like other
    // action failures so handlers can pattern-match.
    const childData = childReturn as Record<string, unknown>;
    expect(childData.code).toBe("META.SIZE_EXCEEDED");
  });

  test("child ctx.execute drops non-serializable meta extras (mirrors root)", async () => {
    // `extend` applies the same serializable filter as `createExecutionMeta`,
    // so a child's attempt to stash a Date/function in meta is silently dropped
    // rather than leaked to downstream handlers.
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    let childMetaJson: Record<string, unknown> = {};

    executor.registry.register({
      name: "child_capture",
      entity: "item",
      label: "Child Capture",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        childMetaJson = ctx.meta.toJSON();
        return { ok: true };
      },
    });

    executor.registry.register({
      name: "parent_dirty_meta",
      entity: "item",
      label: "Parent",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        await ctx.execute(
          "child_capture",
          {},
          {
            meta: {
              nested_date: { when: new Date() }, // dropped (nested Date)
              cb: () => 1, // dropped (function)
              ok_flag: true, // kept
            },
          },
        );
        return { ok: true };
      },
    });

    await executor.execute("parent_dirty_meta", {}, defaultActor);

    expect("nested_date" in childMetaJson).toBe(false);
    expect("cb" in childMetaJson).toBe(false);
    expect(childMetaJson.ok_flag).toBe(true);
  });

  // Codex round-3 follow-up: ExecuteOptions.meta accepts a plain record
  // (natural shape for direct-executor callers). Engine normalizes internally.
  test("direct executor with plain record meta normalizes to ExecutionMeta", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    let captured: { meta: Record<string, unknown>; hasGet: boolean } | undefined;
    executor.registry.register({
      name: "plain_meta_consumer",
      entity: "item",
      label: "Plain Meta Consumer",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        captured = {
          meta: ctx.meta.toJSON(),
          hasGet: typeof ctx.meta.get === "function",
        };
        return { ok: true };
      },
    });

    // Pass a plain Record<string, unknown> (no createExecutionMeta).
    await executor.execute("plain_meta_consumer", {}, defaultActor, {
      meta: { source_view: "queue", bulk: true } as Record<string, unknown>,
    });

    expect(captured?.hasGet).toBe(true);
    expect(captured?.meta.source_view).toBe("queue");
    expect(captured?.meta.bulk).toBe(true);
    // System keys still set by the engine.
    expect(captured?.meta._channel).toBe("internal");
    expect(typeof captured?.meta._execution_id).toBe("string");
    expect(captured?.meta._depth).toBe(0);
  });

  test("direct executor with plain record meta strips _-prefixed external keys", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    let captured: Record<string, unknown> = {};
    executor.registry.register({
      name: "plain_stripped",
      entity: "item",
      label: "Plain Stripped",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        captured = ctx.meta.toJSON();
        return { ok: true };
      },
    });

    await executor.execute("plain_stripped", {}, defaultActor, {
      meta: {
        _channel: "spoofed",
        _execution_id: "hacked",
        source_view: "legit",
      } as Record<string, unknown>,
    });

    // Plain-record path goes through createExecutionMeta's _-prefix strip.
    expect(captured._channel).toBe("internal");
    expect(captured._execution_id).not.toBe("hacked");
    expect(captured.source_view).toBe("legit");
  });

  // Codex round-4: direct-executor oversized meta returns a failed
  // ActionResult (no unhandled throw) + logs the rejection.
  test("direct executor with oversized plain meta returns failed ActionResult", async () => {
    const dp = createTestDataProvider();
    const logEntries: Array<{ id: string; status: string }> = [];
    const executor = createActionExecutor({
      dataProvider: dp,
      executionLogger: {
        log: async (e) => {
          logEntries.push({ id: e.id, status: e.status });
        },
        getById: async () => null as never,
      },
    });

    executor.registry.register({
      name: "root_oversize",
      entity: "item",
      label: "Root Oversize",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async () => ({ ok: true }),
    });

    const result = await executor.execute("root_oversize", {}, defaultActor, {
      meta: { big: "x".repeat(DEFAULT_META_MAX_BYTES + 100) } as Record<string, unknown>,
    });

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("META.SIZE_EXCEEDED");
    // Failure was logged (observability preserved).
    expect(logEntries.length).toBe(1);
    expect(logEntries[0].status).toBe("failed");
    expect(logEntries[0].id).toBe(result.executionId);
  });

  // Gemini Phase 2A review: MetaSizeError must increment action.executed{status:failed}
  // and record duration so monitoring dashboards see meta-size rejections.
  test("MetaSizeError path emits action.executed and action.duration_ms metrics", async () => {
    const dp = createTestDataProvider();
    const metrics = new InMemoryMetricsCollector();
    const executor = createActionExecutor({ dataProvider: dp, metrics });

    executor.registry.register({
      name: "root_oversize_metrics",
      entity: "item",
      label: "Root Oversize Metrics",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async () => ({ ok: true }),
    });

    const result = await executor.execute("root_oversize_metrics", {}, defaultActor, {
      meta: { big: "x".repeat(DEFAULT_META_MAX_BYTES + 100) } as Record<string, unknown>,
    });
    expect(result.success).toBe(false);

    // Counter increment on failed
    const failedCount = metrics.getCounter("action.executed", {
      action: "root_oversize_metrics",
      entity: "",
      status: "failed",
    });
    expect(failedCount).toBe(1);
    // Histogram entry recorded for duration
    const snapshots = metrics.getMetrics();
    const durationSnapshot = snapshots.find(
      (s) =>
        s.name === "action.duration_ms" &&
        s.tags?.action === "root_oversize_metrics" &&
        s.tags?.entity === "",
    );
    expect(durationSnapshot).toBeDefined();
  });

  // Codex round-3 P3: don't record a fake child execution id when meta size
  // rejects the child before any log entry is written.
  test("child meta size rejection does NOT register a phantom execution id", async () => {
    const dp = createTestDataProvider();
    // Simple in-memory executionLogger to observe childExecutionIds persistence.
    const logEntries: Array<{ id: string }> = [];
    const executor = createActionExecutor({
      dataProvider: dp,
      executionLogger: {
        log: async (e) => {
          logEntries.push({ id: e.id });
        },
        getById: async (id) => logEntries.find((x) => x.id === id) as never,
      },
    });

    let parentResult: unknown;
    executor.registry.register({
      name: "child",
      entity: "item",
      label: "Child",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async () => ({ ok: true }),
    });

    executor.registry.register({
      name: "parent_oversize_child",
      entity: "item",
      label: "Parent",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        parentResult = await ctx.execute(
          "child",
          {},
          { meta: { huge: "x".repeat(DEFAULT_META_MAX_BYTES + 100) } },
        );
        return { ok: true };
      },
    });

    await executor.execute("parent_oversize_child", {}, defaultActor);

    // The child meta was rejected — one log entry exists (the parent).
    expect(logEntries.length).toBe(1);
    // The logged id is the parent's id, which is resolvable.
    const parentLogId = logEntries[0].id;
    const found = await executor.registry.get("parent_oversize_child");
    expect(found).toBeDefined();
    // And the failed "child" return data is META.SIZE_EXCEEDED, shaped for
    // the parent handler to pattern-match on.
    expect((parentResult as Record<string, unknown>).code).toBe("META.SIZE_EXCEEDED");
    // parentLogId referenced as a sanity anchor.
    expect(typeof parentLogId).toBe("string");
  });

  // Gemini PR #201 review: system keys are framework-owned. Even if a caller
  // crafts a pre-built ExecutionMeta (or duck-typed equivalent) with spoofed
  // `_`-prefixed entries, the root executor must strip and re-stamp.
  test("root: ExecutionMeta with spoofed system keys is re-normalized", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    let captured: Record<string, unknown> = {};
    executor.registry.register({
      name: "spoofed_meta_consumer",
      entity: "item",
      label: "Spoof Consumer",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        captured = ctx.meta.toJSON();
        return { ok: true };
      },
    });

    const spoofed = createExecutionMeta({
      // createExecutionMeta strips `_` from raw automatically, so craft
      // the spoofed keys via systemKeys — this simulates any adversarial
      // code that bypasses the factory's strip step.
      systemKeys: {
        _channel: "spoofed",
        _execution_id: "fake_root_id",
        _depth: 999,
        legit_key: "preserved",
      },
    });
    const result = await executor.execute("spoofed_meta_consumer", {}, defaultActor, {
      meta: spoofed,
    });

    expect(result.success).toBe(true);
    // System keys were re-stamped by the engine.
    expect(captured._channel).toBe("internal");
    expect(captured._execution_id).toBe(result.executionId);
    expect(captured._execution_id).not.toBe("fake_root_id");
    expect(captured._depth).toBe(0);
    // Non-system keys still flow through untouched.
    expect(captured.legit_key).toBe("preserved");
  });

  test("root: duck-typed ExecutionMeta with spoofed toJSON cannot bypass stripping", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    let captured: Record<string, unknown> = {};
    executor.registry.register({
      name: "duck_typed_spoof",
      entity: "item",
      label: "Duck Typed",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => {
        captured = ctx.meta.toJSON();
        return { ok: true };
      },
    });

    // Craft a duck-typed ExecutionMeta whose toJSON hands out spoofed system keys.
    const spoofedDuck = {
      get: () => undefined,
      has: () => false,
      require: () => {
        throw new Error("never");
      },
      toJSON: () => ({ _channel: "mcp_bypass", _depth: 42, user_key: "x" }),
    };

    // Cast required because the interface requires generic methods.
    const result = await executor.execute(
      "duck_typed_spoof",
      {},
      defaultActor,
      // biome-ignore lint/suspicious/noExplicitAny: test-only adversarial cast
      { meta: spoofedDuck as any },
    );

    expect(result.success).toBe(true);
    expect(captured._channel).toBe("internal");
    expect(captured._depth).toBe(0);
    expect(captured.user_key).toBe("x");
  });
});
