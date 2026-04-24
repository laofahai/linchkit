/**
 * CommandLayer — ExecutionMeta integration (Spec 65 Phase 1).
 *
 * Covers end-to-end flow of caller-provided meta into action handlers:
 * - Caller meta reaches the handler via `ctx.meta.get(...)`.
 * - `_`-prefixed keys in caller meta are stripped (system key wins).
 * - Over-size meta (>8 KB) short-circuits with `META.SIZE_EXCEEDED`.
 * - `ctx.meta` is always populated even when the caller supplies no meta.
 */

import { describe, expect, test } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import type { ActionContext, ActionDefinition } from "../src/types/action";
import { DEFAULT_META_MAX_BYTES } from "../src/types/execution-meta";
import { createTestDataProvider } from "./command-layer-helpers";

/** Build a test setup with a handler that captures its ctx into `captured`. */
function setup(onExecute?: (ctx: ActionContext) => void) {
  const dp = createTestDataProvider();
  const executor = createActionExecutor({ dataProvider: dp });

  const captureAction: ActionDefinition = {
    name: "capture_meta",
    entity: "item",
    label: "Capture Meta",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      onExecute?.(ctx);
      return { ok: true };
    },
  };
  executor.registry.register(captureAction);
  const layer = createCommandLayer({ executor });
  return { layer };
}

describe("CommandLayer — ExecutionMeta integration", () => {
  test("caller-provided meta reaches action handler via ctx.meta", async () => {
    let capturedCtx: ActionContext | undefined;
    const { layer } = setup((ctx) => {
      capturedCtx = ctx;
    });

    const result = await layer.execute({
      command: "capture_meta",
      input: {},
      meta: { source_view: "approval_queue", bulk: true },
      channel: "http",
    });

    expect(result.success).toBe(true);
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.meta.get<string>("source_view")).toBe("approval_queue");
    expect(capturedCtx?.meta.get<boolean>("bulk")).toBe(true);
  });

  test("external `_channel` in caller meta is stripped — system key wins", async () => {
    let capturedCtx: ActionContext | undefined;
    const { layer } = setup((ctx) => {
      capturedCtx = ctx;
    });

    await layer.execute({
      command: "capture_meta",
      input: {},
      meta: {
        _channel: "evil_override",
        _execution_id: "spoofed_exec",
        source_view: "legit",
      },
      channel: "http",
    });

    // _channel is set by the framework from ctx.channel.
    expect(capturedCtx?.meta.get<string>("_channel")).toBe("http");
    // _execution_id comes from the pipeline-assigned traceId when present
    // (or is absent). Either way, not "spoofed_exec".
    expect(capturedCtx?.meta.get<string>("_execution_id")).not.toBe("spoofed_exec");
    // Legitimate user keys still pass through.
    expect(capturedCtx?.meta.get<string>("source_view")).toBe("legit");
  });

  test("9 KB meta payload returns META.SIZE_EXCEEDED", async () => {
    const { layer } = setup();

    const big = "x".repeat(DEFAULT_META_MAX_BYTES + 1024);
    const result = await layer.execute({
      command: "capture_meta",
      input: {},
      meta: { big },
    });

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("META.SIZE_EXCEEDED");
  });

  test("ctx.meta is populated with system keys even when caller supplies no meta", async () => {
    let capturedCtx: ActionContext | undefined;
    const { layer } = setup((ctx) => {
      capturedCtx = ctx;
    });

    await layer.execute({
      command: "capture_meta",
      input: {},
      channel: "internal",
    });

    expect(capturedCtx?.meta).toBeDefined();
    expect(capturedCtx?.meta.get<string>("_channel")).toBe("internal");
    expect(capturedCtx?.meta.get<number>("_depth")).toBe(0);
  });

  test("ctx.meta.toJSON returns a plain object snapshot", async () => {
    let capturedCtx: ActionContext | undefined;
    const { layer } = setup((ctx) => {
      capturedCtx = ctx;
    });

    await layer.execute({
      command: "capture_meta",
      input: {},
      meta: { source_view: "queue" },
      channel: "ui",
    });

    const snapshot = capturedCtx?.meta.toJSON() ?? {};
    expect(snapshot.source_view).toBe("queue");
    expect(snapshot._channel).toBe("ui");
  });

  test("middleware that mutates ctx.meta feeds the handler-visible meta", async () => {
    // Existing CommandContext.meta middleware-internal contract (Spec 65 §8.3):
    // middleware may add keys before the action handler runs; those should
    // appear in ctx.meta.
    let capturedCtx: ActionContext | undefined;
    const { layer } = setup((ctx) => {
      capturedCtx = ctx;
    });

    layer.use({
      name: "inject_meta",
      slot: "pre",
      handler: async (ctx, next) => {
        ctx.meta.injected_flag = true;
        await next();
      },
    });

    await layer.execute({
      command: "capture_meta",
      input: {},
      meta: { source_view: "queue" },
    });

    expect(capturedCtx?.meta.get<boolean>("injected_flag")).toBe(true);
    expect(capturedCtx?.meta.get<string>("source_view")).toBe("queue");
  });
});
