/**
 * Spec 63 Phase 1 — round-4 safety regression tests.
 *
 * Covers:
 *  1. Date values compared by timestamp, not prototype shape.
 *  2. Handler-based create actions with caller-supplied `id` are NOT blocked
 *     by the lock preflight (they have no setFields / stateTransition marker
 *     so the executor can't assume an existing record).
 *  3. Declarative-update actions (setFields / stateTransition) still
 *     fail-closed when the target record can't be read.
 *  4. `applyOverride` can add lockWhen / readonly at runtime (EntityOverride
 *     type widened to FieldOverrideProps to accept Spec 63 keys).
 */

import { describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import { lockActor as actor, createMemoryDataProvider } from "./field-lock-helpers";

// ── 1. Date structural equality ───────────────────────────────────

describe("Spec 63 — Date values compared by timestamp, not prototype shape", () => {
  it("immutable Date field blocks update to a different timestamp", async () => {
    const entity: EntityDefinition = {
      name: "booking",
      label: "Booking",
      fields: {
        created_at: { type: "datetime", immutable: true },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("booking", {
      id: "b-1",
      created_at: new Date("2024-01-01T00:00:00Z"),
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_booking",
      entity: "booking",
      label: "Update Booking",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("booking", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute(
      "update_booking",
      { id: "b-1", created_at: new Date("2025-06-15T00:00:00Z") },
      actor,
    );
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.immutable");
  });

  it("immutable Date field allows identical-timestamp re-submit", async () => {
    const entity: EntityDefinition = {
      name: "booking",
      label: "Booking",
      fields: {
        created_at: { type: "datetime", immutable: true },
        notes: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    const existingTs = new Date("2024-01-01T00:00:00Z");
    await dataProvider.create("booking", { id: "b-2", created_at: existingTs, notes: "" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_booking_2",
      entity: "booking",
      label: "Update Booking",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("booking", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    // Fresh Date instance with same timestamp — must be treated as unchanged.
    const result = await executor.execute(
      "update_booking_2",
      { id: "b-2", created_at: new Date(existingTs.getTime()), notes: "updated" },
      actor,
    );
    expect(result.success).toBe(true);
  });
});

// ── 2. Handler-based create with caller-supplied id ───────────────

describe("Spec 63 — handler-based create actions with caller-supplied id are not blocked", () => {
  it("handler-based create does NOT trigger a lock_preflight error", async () => {
    const entity: EntityDefinition = {
      name: "widget",
      label: "Widget",
      fields: {
        code: { type: "string", immutable: true },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);

    const store = new Map<string, Record<string, unknown>>();
    const dataProvider = {
      async get(_s: string, id: string) {
        const r = store.get(id);
        if (!r) throw new Error(`not found: ${id}`);
        return r;
      },
      async query() {
        return [];
      },
      async create(_s: string, data: Record<string, unknown>) {
        const id = data.id as string;
        store.set(id, data);
        return data;
      },
      async update(_s: string, _id: string, _data: Record<string, unknown>) {
        throw new Error("update should not be called");
      },
      async delete() {},
      async count() {
        return store.size;
      },
    };

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "create_widget",
      entity: "widget",
      label: "Create Widget",
      input: { id: { type: "string", required: true }, code: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        return ctx.create("widget", ctx.input);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("create_widget", { id: "w-1", code: "ABC" }, actor);
    expect(result.success).toBe(true);
  });

  it("declarative-update action with missing record still fails-closed", async () => {
    const entity: EntityDefinition = {
      name: "ledger",
      label: "Ledger",
      fields: {
        frozen_code: { type: "string", immutable: true },
        note: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);

    const dataProvider = {
      async get(): Promise<Record<string, unknown>> {
        throw new Error("missing");
      },
      async query() {
        return [];
      },
      async create(_s: string, data: Record<string, unknown>) {
        return data;
      },
      async update(_s: string, _id: string, data: Record<string, unknown>) {
        return data;
      },
      async delete() {},
      async count() {
        return 0;
      },
    };

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "touch_ledger",
      entity: "ledger",
      label: "Touch Ledger",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      setFields: {
        note: "touched",
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("touch_ledger", { id: "missing" }, actor);
    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.locked");
    const context = data.context as Record<string, unknown> | undefined;
    expect(context?.constraint).toBe("lock_preflight");
  });
});

// ── 3. applyOverride can add lockWhen / readonly ──────────────────

describe("Spec 63 — applyOverride supports lockWhen/readonly additions", () => {
  it("override that adds lockWhen enforces at engine level", async () => {
    const entity: EntityDefinition = {
      name: "order_ovr",
      label: "Order",
      fields: {
        amount: { type: "number" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    entityRegistry.applyOverride("order_ovr", {
      fields: { amount: { lockWhen: { state: "submitted" } } },
    });
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("order_ovr", { id: "oo-1", amount: 100, status: "submitted" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_order_ovr",
      entity: "order_ovr",
      label: "Update Order",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("order_ovr", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("update_order_ovr", { id: "oo-1", amount: 200 }, actor);
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.locked");
  });
});
