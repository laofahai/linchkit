/**
 * Spec 63 Phase 3 — Interceptor registry + Action Engine integration tests.
 *
 * Covers:
 *  - identity (empty registry → value unchanged)
 *  - single-handler transforms
 *  - ascending-order chaining (each handler's output feeds the next)
 *  - fail-closed: a throwing handler keeps its INPUT and continues
 *  - fail-closed: a handler returning null/undefined keeps its INPUT
 *  - fail-closed integrity: in-place mutation then throw/null, and non-array
 *    returns, cannot weaken the violation set (handlers get a defensive clone)
 *  - end-to-end via createActionExecutor: a `field-lock-check` interceptor that
 *    returns `[]` lets a normally-locked update succeed; a passthrough one
 *    still raises a LockViolationError.
 */

import { describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import type { FieldLockViolation } from "../src/engine/field-lock-checker";
import { createInterceptorRegistry, type FieldLockCheckContext } from "../src/engine/interceptors";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import type { Logger } from "../src/types/logger";
import { createMemoryDataProvider, lockActor } from "./field-lock-helpers";

// ── Fixtures ───────────────────────────────────────────────

const ctx: FieldLockCheckContext = {
  entity: "doc",
  actor: { type: "human", id: "u-1", groups: [] } as Actor,
  record: {},
  input: {},
};

function violation(field: string): FieldLockViolation {
  return { field, type: "immutable", mode: "hard", message: `Field "${field}" is immutable` };
}

/** Logger spy that records every error call. */
function createSpyLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const noop = () => {};
  return {
    errors,
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: (message: string) => {
        errors.push(message);
      },
    },
  };
}

// ── Unit: identity ─────────────────────────────────────────

describe("InterceptorRegistry — identity", () => {
  it("returns the value unchanged when no interceptor is registered", async () => {
    const registry = createInterceptorRegistry();
    const input = [violation("code"), violation("sku")];
    const out = await registry.run("field-lock-check", input, ctx);
    expect(out).toBe(input);
    expect(registry.has("field-lock-check")).toBe(false);
  });
});

// ── Unit: single handler ───────────────────────────────────

describe("InterceptorRegistry — single handler", () => {
  it("a handler returning [] empties the violation set", async () => {
    const registry = createInterceptorRegistry();
    registry.register({
      point: "field-lock-check",
      capability: "cap-lock",
      handler: () => [],
    });
    expect(registry.has("field-lock-check")).toBe(true);
    const out = await registry.run("field-lock-check", [violation("code")], ctx);
    expect(out).toEqual([]);
  });

  it("a handler returning a subset keeps that subset", async () => {
    const registry = createInterceptorRegistry();
    registry.register({
      point: "field-lock-check",
      capability: "cap-lock",
      handler: (v) => v.filter((x) => x.field !== "code"),
    });
    const out = await registry.run("field-lock-check", [violation("code"), violation("sku")], ctx);
    expect(out).toEqual([violation("sku")]);
  });
});

// ── Unit: ascending-order chaining ─────────────────────────

describe("InterceptorRegistry — chaining", () => {
  it("runs in ascending order, threading each output into the next", async () => {
    const registry = createInterceptorRegistry();
    const calls: string[] = [];

    // Registered out of order; B has higher `order` so must run after A.
    registry.register({
      point: "field-lock-check",
      capability: "cap-b",
      order: 200,
      handler: (v) => {
        calls.push("B");
        // B should see A's output (X already dropped).
        expect(v.some((x) => x.field === "X")).toBe(false);
        return v.filter((x) => x.field !== "Y");
      },
    });
    registry.register({
      point: "field-lock-check",
      capability: "cap-a",
      order: 100,
      handler: (v) => {
        calls.push("A");
        return v.filter((x) => x.field !== "X");
      },
    });

    const out = await registry.run(
      "field-lock-check",
      [violation("X"), violation("Y"), violation("Z")],
      ctx,
    );

    expect(calls).toEqual(["A", "B"]);
    expect(out).toEqual([violation("Z")]);
  });
});

// ── Unit: fail-closed (throw) ──────────────────────────────

describe("InterceptorRegistry — fail-closed on throw", () => {
  it("keeps the throwing handler's input, logs, and continues the chain", async () => {
    const { logger, errors } = createSpyLogger();
    const registry = createInterceptorRegistry({ logger });
    const calls: string[] = [];

    registry.register({
      point: "field-lock-check",
      capability: "cap-broken",
      order: 100,
      handler: () => {
        calls.push("broken");
        throw new Error("boom");
      },
    });
    registry.register({
      point: "field-lock-check",
      capability: "cap-after",
      order: 200,
      handler: (v) => {
        calls.push("after");
        // The broken handler's input must have survived untouched.
        expect(v).toEqual([violation("code")]);
        return [];
      },
    });

    const out = await registry.run("field-lock-check", [violation("code")], ctx);

    expect(calls).toEqual(["broken", "after"]);
    expect(out).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("cap-broken");
    expect(errors[0]).toContain("field-lock-check");
  });
});

// ── Unit: fail-closed (null/undefined) ─────────────────────

describe("InterceptorRegistry — fail-closed on null/undefined", () => {
  it("keeps the input when a handler returns null", async () => {
    const { logger, errors } = createSpyLogger();
    const registry = createInterceptorRegistry({ logger });
    registry.register({
      point: "field-lock-check",
      capability: "cap-null",
      // Deliberately violate the contract to exercise the fail-closed path.
      handler: (() => null) as unknown as () => FieldLockViolation[],
    });
    const input = [violation("code")];
    const out = await registry.run("field-lock-check", input, ctx);
    expect(out).toEqual(input);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("cap-null");
  });

  it("keeps the input when a handler returns undefined", async () => {
    const { logger, errors } = createSpyLogger();
    const registry = createInterceptorRegistry({ logger });
    registry.register({
      point: "field-lock-check",
      capability: "cap-undef",
      handler: (() => undefined) as unknown as () => FieldLockViolation[],
    });
    const input = [violation("sku")];
    const out = await registry.run("field-lock-check", input, ctx);
    expect(out).toEqual(input);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("cap-undef");
  });
});

// ── Unit: fail-closed integrity (in-place mutation / invalid return) ──

describe("InterceptorRegistry — fail-closed integrity", () => {
  it("a handler that empties the array in place then throws cannot weaken the set", async () => {
    const { logger, errors } = createSpyLogger();
    const registry = createInterceptorRegistry({ logger });
    registry.register({
      point: "field-lock-check",
      capability: "cap-evil",
      handler: (v) => {
        // Hostile: strip every violation in place, THEN crash. Fail-closed
        // must restore the original (non-empty) set — the handler only ever
        // sees a defensive clone, so the authoritative value is untouched.
        v.length = 0;
        throw new Error("boom");
      },
    });
    const input = [violation("amount")];
    const out = await registry.run("field-lock-check", input, ctx);
    expect(out).toEqual([violation("amount")]);
    // The caller's array must also be untouched (handler got a clone).
    expect(input).toEqual([violation("amount")]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("cap-evil");
  });

  it("a handler that mutates a violation property in place then throws cannot weaken the set", async () => {
    const { logger, errors } = createSpyLogger();
    const registry = createInterceptorRegistry({ logger });
    registry.register({
      point: "field-lock-check",
      capability: "cap-evil-element",
      handler: (v) => {
        // Hostile: rewrite the ENTRY in place (not the array container) so the
        // violation appears to target an allowed field, THEN crash. The deep
        // clone (array + elements) means the handler only ever touches its own
        // copy — the authoritative element must remain `amount`/`immutable`.
        const first = v[0];
        if (first) {
          first.field = "allowed";
          first.type = "lockWhen";
          first.message = "tampered";
        }
        throw new Error("boom");
      },
    });
    const input = [violation("amount")];
    const out = await registry.run("field-lock-check", input, ctx);
    expect(out).toEqual([violation("amount")]);
    // The caller's array AND its element must be untouched (handler got a deep clone).
    expect(input).toEqual([violation("amount")]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("cap-evil-element");
  });

  it("a handler that empties the array in place then returns null cannot weaken the set", async () => {
    const { logger, errors } = createSpyLogger();
    const registry = createInterceptorRegistry({ logger });
    registry.register({
      point: "field-lock-check",
      capability: "cap-evil-null",
      handler: ((v: FieldLockViolation[]) => {
        v.length = 0;
        return null;
      }) as unknown as () => FieldLockViolation[],
    });
    const input = [violation("amount")];
    const out = await registry.run("field-lock-check", input, ctx);
    expect(out).toEqual([violation("amount")]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("cap-evil-null");
  });

  it("a handler returning a non-array value is rejected (fail-closed)", async () => {
    const { logger, errors } = createSpyLogger();
    const registry = createInterceptorRegistry({ logger });
    registry.register({
      point: "field-lock-check",
      capability: "cap-bad-type",
      handler: (() => "not-an-array") as unknown as () => FieldLockViolation[],
    });
    const input = [violation("amount")];
    const out = await registry.run("field-lock-check", input, ctx);
    expect(out).toEqual(input);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("cap-bad-type");
  });
});

// ── Integration via createActionExecutor ───────────────────

const lockedEntity: EntityDefinition = {
  name: "invoice",
  fields: {
    code: { type: "string", immutable: true },
    title: { type: "string" },
  },
};

const updateAction: ActionDefinition = {
  name: "update_record",
  entity: "invoice",
  label: "Update",
  input: { id: { type: "string", required: true } },
  policy: { mode: "sync", transaction: false },
  handler: async (handlerCtx) => {
    const id = handlerCtx.input.id as string;
    const { id: _id, ...rest } = handlerCtx.input as Record<string, unknown>;
    return handlerCtx.update("invoice", id, rest);
  },
};

describe("Spec 63 Phase 3 — Action Engine integration", () => {
  it("a field-lock-check interceptor returning [] lets a locked update succeed", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(lockedEntity);
    const dataProvider = createMemoryDataProvider();

    let sawContext: FieldLockCheckContext | undefined;
    const interceptorRegistry = createInterceptorRegistry();
    interceptorRegistry.register({
      point: "field-lock-check",
      capability: "cap-lock-bypass",
      handler: (_violations, c) => {
        sawContext = c;
        return [];
      },
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry, interceptorRegistry });
    executor.registry.register(updateAction);

    await dataProvider.create("invoice", { id: "inv-1", code: "OLD", title: "T" });

    const result = await executor.execute("update_record", { id: "inv-1", code: "NEW" }, lockActor);

    expect(result.success).toBe(true);
    const record = await dataProvider.get("invoice", "inv-1");
    expect(record.code).toBe("NEW");

    // The interceptor received the full enforcement context.
    expect(sawContext?.entity).toBe("invoice");
    expect(sawContext?.actor.id).toBe(lockActor.id);
    expect(sawContext?.record.code).toBe("OLD");
    expect(sawContext?.input.code).toBe("NEW");
  });

  it("a passthrough interceptor still raises a LockViolationError", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(lockedEntity);
    const dataProvider = createMemoryDataProvider();

    const interceptorRegistry = createInterceptorRegistry();
    interceptorRegistry.register({
      point: "field-lock-check",
      capability: "cap-passthrough",
      handler: (v) => v,
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry, interceptorRegistry });
    executor.registry.register(updateAction);

    await dataProvider.create("invoice", { id: "inv-2", code: "OLD", title: "T" });

    const result = await executor.execute("update_record", { id: "inv-2", code: "NEW" }, lockActor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
    // Record must NOT have mutated.
    const record = await dataProvider.get("invoice", "inv-2");
    expect(record.code).toBe("OLD");
  });

  it("with no interceptor registry, the lock check is identical to Phase 1", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(lockedEntity);
    const dataProvider = createMemoryDataProvider();

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register(updateAction);

    await dataProvider.create("invoice", { id: "inv-3", code: "OLD", title: "T" });

    const result = await executor.execute("update_record", { id: "inv-3", code: "NEW" }, lockActor);

    expect(result.success).toBe(false);
  });
});
