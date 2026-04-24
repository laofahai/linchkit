/**
 * Spec 63 Phase 1 — edge-case regression tests surfaced in Codex rounds 2 & 3.
 *
 * Covers:
 *  1. Locked-field same-value re-writes are no-ops (full-record UI flows).
 *  2. Structural (key-order-insensitive) equality on JSON / object fields.
 *  3. Nested ctx.execute reads lock state from the parent's tx provider.
 *  4. Fail-closed when the pre-lock record fetch errors.
 */

import { describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import { lockActor as actor, createMemoryDataProvider } from "./field-lock-helpers";

// ── 1. Same-value re-writes on locked fields ─────────────────────────
// Codex round-2 P1: full-record update flows commonly echo back all
// fields. Locked fields sent with unchanged values must not trigger
// violations — only actual modifications should.

describe("Spec 63 — locked-field same-value re-writes are no-ops", () => {
  it("lockWhen field re-sent with identical value does NOT violate", async () => {
    const entity: EntityDefinition = {
      name: "order",
      label: "Order",
      fields: {
        amount: { type: "number", lockWhen: { state: "submitted" } },
        notes: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("order", { id: "o-1", amount: 100, status: "submitted", notes: "" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_order",
      entity: "order",
      label: "Update Order",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("order", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    // Full-record submit: amount unchanged, notes edited — should succeed.
    const result = await executor.execute(
      "update_order",
      { id: "o-1", amount: 100, notes: "updated" },
      actor,
    );
    expect(result.success).toBe(true);
    const after = await dataProvider.get("order", "o-1");
    expect(after.notes).toBe("updated");
    expect(after.amount).toBe(100);
  });

  it("lockAllWhen + full record with unchanged values on locked fields succeeds", async () => {
    const entity: EntityDefinition = {
      name: "invoice",
      label: "Invoice",
      lockAllWhen: { state: "posted" },
      lockAllowFields: ["notes"],
      fields: {
        amount: { type: "number" },
        notes: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("invoice", { id: "i-1", amount: 500, status: "posted", notes: "" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_invoice",
      entity: "invoice",
      label: "Update Invoice",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("invoice", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute(
      "update_invoice",
      { id: "i-1", amount: 500, notes: "adjusted" },
      actor,
    );
    expect(result.success).toBe(true);
  });

  it("lockWhen field submitted with CHANGED value still violates", async () => {
    const entity: EntityDefinition = {
      name: "order",
      label: "Order",
      fields: {
        amount: { type: "number", lockWhen: { state: "submitted" } },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("order", { id: "o-2", amount: 100, status: "submitted" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_order",
      entity: "order",
      label: "Update Order",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("order", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("update_order", { id: "o-2", amount: 200 }, actor);
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.locked");
  });
});

// ── 2. Structural equality on JSON / object fields ─────────────────
// Codex round-3 P2: JSON.stringify-based equality would reject reordered
// keys. Switched to key-order-insensitive structural comparison.

describe("Spec 63 — structural equality on JSON / object fields", () => {
  it("reordered object keys are treated as unchanged (no violation)", async () => {
    const entity: EntityDefinition = {
      name: "config",
      label: "Config",
      fields: {
        settings: { type: "json", immutable: true },
        notes: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("config", {
      id: "c-1",
      settings: { alpha: 1, beta: 2, nested: { x: "a", y: "b" } },
      notes: "",
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_config",
      entity: "config",
      label: "Update Config",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("config", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    // Same data, different key order in top-level and nested object.
    const result = await executor.execute(
      "update_config",
      {
        id: "c-1",
        settings: { nested: { y: "b", x: "a" }, beta: 2, alpha: 1 },
        notes: "updated",
      },
      actor,
    );
    expect(result.success).toBe(true);
  });

  it("structurally different JSON still blocks on immutable field", async () => {
    const entity: EntityDefinition = {
      name: "config",
      label: "Config",
      fields: {
        settings: { type: "json", immutable: true },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("config", { id: "c-2", settings: { alpha: 1 } });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_config_2",
      entity: "config",
      label: "Update Config",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("config", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute(
      "update_config_2",
      { id: "c-2", settings: { alpha: 1, beta: 3 } }, // new key added
      actor,
    );
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.immutable");
  });
});

// ── 3. Nested ctx.execute reads from parent's tx provider ─────────
// Codex round-3 P1: when a parent action is inside a transaction and
// calls ctx.execute(...), the child's lock-preflight fetch must use the
// inherited transactional provider so intra-transaction state changes
// (e.g. parent setting `status = submitted`) are visible to the child's
// lockWhen check.

describe("Spec 63 — nested ctx.execute reads from parent's transactional provider", () => {
  it("child sees parent's in-transaction status when evaluating lockWhen", async () => {
    const entity: EntityDefinition = {
      name: "po",
      label: "Purchase Order",
      fields: {
        amount: { type: "number", lockWhen: { state: "submitted" } },
        status: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);

    // Base provider returns the "pre-transaction" snapshot (status = draft).
    const baseProvider = createMemoryDataProvider();
    await baseProvider.create("po", { id: "po-1", amount: 100, status: "draft" });

    // Parent's tx provider simulates the state AFTER the parent wrote
    // status = submitted earlier in the same transaction.
    const txSnapshot = new Map<string, Record<string, unknown>>();
    txSnapshot.set("po-1", { id: "po-1", amount: 100, status: "submitted" });
    const parentTxProvider = {
      async get(_schema: string, id: string) {
        const r = txSnapshot.get(id);
        if (!r) throw new Error("not found");
        return { ...r };
      },
      async query() {
        return Array.from(txSnapshot.values());
      },
      async create(_s: string, data: Record<string, unknown>) {
        return data;
      },
      async update(_s: string, id: string, data: Record<string, unknown>) {
        const prev = txSnapshot.get(id) ?? {};
        const merged = { ...prev, ...data };
        txSnapshot.set(id, merged);
        return merged;
      },
      async delete() {},
      async count() {
        return txSnapshot.size;
      },
    };

    const executor = createActionExecutor({
      dataProvider: baseProvider,
      entityRegistry,
    });
    executor.registry.register({
      name: "update_po",
      entity: "po",
      label: "Update PO",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("po", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    // Simulate child invocation inside parent transaction: _depth = 1,
    // _txDataProvider set. Update attempts to change the now-locked `amount`.
    const result = await executor.execute("update_po", { id: "po-1", amount: 200 }, actor, {
      _depth: 1,
      _txDataProvider: parentTxProvider,
    });
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.locked");
  });
});

// ── 4. Fail-closed on fetch error ─────────────────────────────────
// Codex round-2 P2: a provider whose get() path throws (transient
// error, read replica lag, etc.) must not silently skip lock checks.

describe("Spec 63 — fail-closed when pre-lock record fetch errors", () => {
  it("provider get() throw blocks the update with a lock_preflight error", async () => {
    const entity: EntityDefinition = {
      name: "order",
      label: "Order",
      fields: {
        code: { type: "string", immutable: true },
        notes: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);

    // Minimal provider whose get() always throws, but update() would succeed.
    const dataProvider = {
      async get(): Promise<Record<string, unknown>> {
        throw new Error("simulated read-replica outage");
      },
      async query() {
        return [];
      },
      async create(_schema: string, data: Record<string, unknown>) {
        return data;
      },
      async update(_schema: string, _id: string, data: Record<string, unknown>) {
        return data;
      },
      async delete() {},
      async count() {
        return 0;
      },
    };

    const executor = createActionExecutor({
      dataProvider,
      entityRegistry,
    });
    executor.registry.register({
      name: "update_order_ff",
      entity: "order",
      label: "Update Order",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("order", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute(
      "update_order_ff",
      { id: "o-missing", code: "NEW" },
      actor,
    );
    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.locked");
    const context = data.context as Record<string, unknown> | undefined;
    expect(context?.constraint).toBe("lock_preflight");
  });
});
