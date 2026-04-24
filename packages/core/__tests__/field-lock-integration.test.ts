/**
 * Spec 63 Phase 1 — integration tests (round-2 review fixes).
 *
 * Covers scenarios that go through `entityRegistry.resolve(...)` and the
 * declarative-write coverage added in Step 4b:
 *
 *  1. Inherited `immutable` from a parent schema is enforced on the child.
 *  2. `applyOverride` that flips a field to `immutable` is enforced at resolve
 *     time (overlays cannot be bypassed).
 *  3. `setFields` cannot smuggle a write past an `immutable` field.
 *  4. `setFields` cannot smuggle a write past a `lockWhen`-guarded field.
 *  5. A `stateTransition` out of a state matched by `lockAllWhen` is allowed
 *     (status write is authorized by the state-machine layer, not the lock
 *     check).
 */

import { describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createStateMachine } from "../src/engine/state-machine";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import type { StateDefinition } from "../src/types/state";
import { lockActor as actor, createMemoryDataProvider } from "./field-lock-helpers";

// ── 1. Inherited immutable ─────────────────────────────────

describe("Spec 63 — inherited immutable via resolve()", () => {
  it("child entity inherits parent's immutable flag and enforces it", async () => {
    const entityRegistry = createEntityRegistry();

    // Parent declares `code` as immutable.
    const parent: EntityDefinition = {
      name: "document_base",
      abstract: true,
      fields: {
        code: { type: "string", immutable: true },
        title: { type: "string" },
      },
    };
    // Child adds its own fields and inherits `code` unchanged.
    const child: EntityDefinition = {
      name: "invoice_doc",
      extends: "document_base",
      fields: {
        amount: { type: "number" },
      },
    };
    entityRegistry.register(parent);
    entityRegistry.register(child);

    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider, entityRegistry });

    const updateAction: ActionDefinition = {
      name: "update_record",
      entity: "invoice_doc",
      label: "Update",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const id = ctx.input.id as string;
        const { id: _id, ...rest } = ctx.input as Record<string, unknown>;
        return ctx.update("invoice_doc", id, rest);
      },
    };
    executor.registry.register(updateAction);

    await dataProvider.create("invoice_doc", {
      id: "inv-1",
      code: "INV-001",
      title: "Seed",
      amount: 100,
    });

    const result = await executor.execute("update_record", { id: "inv-1", code: "INV-002" }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
    const ctx = data.context as Record<string, unknown>;
    expect(ctx.field).toBe("code");
  });
});

// ── 2. applyOverride tightens to immutable ─────────────────

describe("Spec 63 — applyOverride flips field to immutable", () => {
  it("override applied at resolve time blocks subsequent immutable mutation", async () => {
    const entityRegistry = createEntityRegistry();
    const entity: EntityDefinition = {
      name: "product",
      fields: {
        // Initially NOT immutable.
        sku: { type: "string" },
        price: { type: "number" },
      },
    };
    entityRegistry.register(entity);

    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider, entityRegistry });

    const updateAction: ActionDefinition = {
      name: "update_record",
      entity: "product",
      label: "Update",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const id = ctx.input.id as string;
        const { id: _id, ...rest } = ctx.input as Record<string, unknown>;
        return ctx.update("product", id, rest);
      },
    };
    executor.registry.register(updateAction);

    await dataProvider.create("product", { id: "p-1", sku: "A", price: 10 });

    // Before override: sku is mutable.
    const before = await executor.execute("update_record", { id: "p-1", sku: "B" }, actor);
    expect(before.success).toBe(true);

    // Apply overlay: flip sku to immutable.
    entityRegistry.applyOverride("product", {
      fields: { sku: { immutable: true } },
    });

    // After override: writing sku to a different value must be blocked.
    const after = await executor.execute("update_record", { id: "p-1", sku: "C" }, actor);
    expect(after.success).toBe(false);
    const data = after.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
    const ctx = data.context as Record<string, unknown>;
    expect(ctx.field).toBe("sku");
  });
});

// ── 3. setFields cannot bypass immutable ───────────────────

describe("Spec 63 — setFields is subject to lock check", () => {
  it("declarative setFields write is blocked by an immutable field", async () => {
    const entityRegistry = createEntityRegistry();
    const entity: EntityDefinition = {
      name: "doc",
      fields: {
        code: { type: "string", immutable: true },
        title: { type: "string" },
      },
    };
    entityRegistry.register(entity);

    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider, entityRegistry });

    // Declarative action — no handler. `setFields` attempts to overwrite
    // the immutable `code` field with a constant string literal.
    const rebrandAction: ActionDefinition = {
      name: "rebrand_doc",
      entity: "doc",
      label: "Rebrand",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      setFields: {
        // Not a `$`-prefixed expression → resolveFieldExpression returns it
        // unchanged. Plain string literal.
        code: "NEW-CODE",
      },
    };
    executor.registry.register(rebrandAction);

    await dataProvider.create("doc", { id: "d-1", code: "OLD-CODE", title: "T" });

    const result = await executor.execute("rebrand_doc", { id: "d-1" }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
    const ctx = data.context as Record<string, unknown>;
    expect(ctx.field).toBe("code");

    // Sanity: record was NOT mutated.
    const record = await dataProvider.get("doc", "d-1");
    expect(record.code).toBe("OLD-CODE");
  });

  it("declarative setFields write is blocked by a lockWhen field", async () => {
    const entityRegistry = createEntityRegistry();
    const entity: EntityDefinition = {
      name: "purchase_request",
      fields: {
        status: { type: "string" },
        amount: { type: "number", lockWhen: { state: "submitted" } },
      },
    };
    entityRegistry.register(entity);

    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider, entityRegistry });

    const bumpAction: ActionDefinition = {
      name: "bump_amount",
      entity: "purchase_request",
      label: "Bump amount",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      setFields: { amount: 9999 },
    };
    executor.registry.register(bumpAction);

    await dataProvider.create("purchase_request", {
      id: "pr-1",
      status: "submitted",
      amount: 100,
    });

    const result = await executor.execute("bump_amount", { id: "pr-1" }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.locked");
    const ctx = data.context as Record<string, unknown>;
    expect(ctx.field).toBe("amount");

    const record = await dataProvider.get("purchase_request", "pr-1");
    expect(record.amount).toBe(100);
  });
});

// ── 4. stateTransition status is exempt ────────────────────

describe("Spec 63 — stateTransition status is exempt from lockAllWhen", () => {
  it("transition out of a state matching lockAllWhen still succeeds", async () => {
    const entityRegistry = createEntityRegistry();
    // Entity locks EVERYTHING while in "draft" — and doesn't allow-list
    // anything. Without the status-exemption, transitioning out of draft
    // would trip the lockAllWhen rule on the status write.
    const entity: EntityDefinition = {
      name: "ticket",
      lockAllWhen: { state: "draft" },
      fields: {
        status: { type: "string" },
        title: { type: "string" },
      },
    };
    entityRegistry.register(entity);

    // A state machine that permits draft -> submitted via the `submit_ticket`
    // action name.
    const stateDef: StateDefinition = {
      name: "ticket_lifecycle",
      entity: "ticket",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted"],
      transitions: [{ from: "draft", to: "submitted", action: "submit_ticket" }],
    };
    const stateMachine = createStateMachine(stateDef);

    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({
      dataProvider,
      entityRegistry,
      stateMachine,
    });

    const submitAction: ActionDefinition = {
      name: "submit_ticket",
      entity: "ticket",
      label: "Submit ticket",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      stateTransition: { from: "draft", to: "submitted" },
    };
    executor.registry.register(submitAction);

    await dataProvider.create("ticket", {
      id: "t-1",
      status: "draft",
      title: "Hello",
    });

    const result = await executor.execute("submit_ticket", { id: "t-1" }, actor);

    expect(result.success).toBe(true);

    const record = await dataProvider.get("ticket", "t-1");
    expect(record.status).toBe("submitted");
  });
});

// ── 6. Same-value re-writes on locked fields ─────────────────────────
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

// ── 7. Fail-closed on fetch error ─────────────────────────────────
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
