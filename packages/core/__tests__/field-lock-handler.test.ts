/**
 * Spec 63 Phase 1 — round-5 handler-path lock enforcement.
 *
 * Covers fixes that moved handler-computed writes from the
 * caller-input-based preflight to a `ctx.update()` wrapper:
 *
 *  1. Handler-computed writes are lock-checked at `ctx.update()` time
 *     (round 5 P1 — bypass via handler-internal writes).
 *  2. Handlers that write only a subset of their input do NOT get flagged on
 *     locked input keys the handler never persists (round 5 P2).
 *  3. Cross-entity `ctx.update()` calls aren't lock-checked against the
 *     current action's entity metadata (round 5 — scoping).
 *  4. Cross-type Date/string equivalence in `structuralEqual` (round 5 P2).
 */

import { describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import { lockActor as actor, createMemoryDataProvider } from "./field-lock-helpers";

// ── 4. Handler-computed writes blocked at ctx.update ──────────────
//
// Round-5 P1: the declarative preflight only sees caller input +
// action.setFields. A handler that computes a write internally (not from
// caller input) previously bypassed the check entirely. The fix wraps
// ctx.update() and runs the check on the exact data argument.

describe("Spec 63 — handler-computed writes are lock-checked at ctx.update", () => {
  it("handler that writes immutable field with a constant is blocked", async () => {
    const entity: EntityDefinition = {
      name: "pr_handler",
      label: "PR",
      fields: {
        code: { type: "string", immutable: true },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("pr_handler", { id: "h-1", code: "REAL" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "approve_pr",
      entity: "pr_handler",
      label: "Approve PR",
      // Input does NOT include `code` — handler injects it. The declarative
      // preflight cannot see this; only the ctx.update wrapper catches it.
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        return ctx.update("pr_handler", ctx.input.id as string, { code: "SPOOFED" });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("approve_pr", { id: "h-1" }, actor);
    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
    const ctx = data.context as Record<string, unknown> | undefined;
    expect(ctx?.field).toBe("code");

    // Sanity: the immutable field was NOT persisted.
    const after = await dataProvider.get("pr_handler", "h-1");
    expect(after.code).toBe("REAL");
  });

  it("handler that writes lockWhen-protected field via computed constant is blocked", async () => {
    const entity: EntityDefinition = {
      name: "pr_lw",
      label: "PR LockWhen",
      fields: {
        status: { type: "string" },
        amount: { type: "number", lockWhen: { state: "submitted" } },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("pr_lw", { id: "l-1", status: "submitted", amount: 100 });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "force_bump",
      entity: "pr_lw",
      label: "Force bump",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        // Caller never supplied `amount` — handler injects it.
        return ctx.update("pr_lw", ctx.input.id as string, { amount: 9999 });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("force_bump", { id: "l-1" }, actor);
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.locked");
  });
});

// ── 5. Handler subset-write scoping ────────────────────────────────
//
// Round-5 P2: the declarative preflight used to include caller input in the
// write set, so an action declaring `input: { id, code, amount }` whose
// handler only writes `{ status }` would trip on `code`/`amount` locks the
// handler never touches. The fix: the declarative preflight drops `input`
// entirely, and the handler path checks only what `ctx.update` actually
// writes.

describe("Spec 63 — handler subset-write is not flagged on unused input keys", () => {
  it("locked input keys not forwarded to ctx.update do not violate", async () => {
    const entity: EntityDefinition = {
      name: "pr_subset",
      label: "PR Subset",
      fields: {
        code: { type: "string", immutable: true },
        amount: { type: "number", immutable: true },
        status: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("pr_subset", {
      id: "s-1",
      code: "ABC",
      amount: 42,
      status: "draft",
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "submit_pr",
      entity: "pr_subset",
      label: "Submit PR",
      // Input declares code & amount (clients send the whole record) but
      // the handler ignores them and writes only `status`.
      input: {
        id: { type: "string", required: true },
        code: { type: "string" },
        amount: { type: "number" },
      },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        return ctx.update("pr_subset", ctx.input.id as string, { status: "submitted" });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute(
      "submit_pr",
      { id: "s-1", code: "DIFFERENT", amount: 999 },
      actor,
    );
    expect(result.success).toBe(true);

    const after = await dataProvider.get("pr_subset", "s-1");
    expect(after.status).toBe("submitted");
    // Critical: code and amount must be unchanged — the handler never wrote them.
    expect(after.code).toBe("ABC");
    expect(after.amount).toBe(42);
  });
});

// ── 6. Cross-entity ctx.update scoping ────────────────────────────
//
// The wrapper only checks locks when the target entity matches the
// current action's entity. A handler may legitimately write to another
// entity (e.g., mirror a record, emit an audit row) — that entity's own
// actions are responsible for its lock enforcement.

describe("Spec 63 — ctx.update on a different entity is not lock-checked here", () => {
  it("writing to a different entity succeeds even when current entity has locks", async () => {
    // Entity A: has an immutable field.
    const entityA: EntityDefinition = {
      name: "entity_a",
      label: "A",
      fields: {
        code: { type: "string", immutable: true },
      },
    };
    // Entity B: no lock metadata at all. Not even registered with
    // entityRegistry to prove the wrapper doesn't consult it.
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entityA);

    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("entity_a", { id: "a-1", code: "AAA" });
    await dataProvider.create("entity_b", { id: "b-1", note: "seed" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "touch_b_via_a",
      entity: "entity_a",
      label: "Touch B via A",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        // Cross-entity write. If the wrapper mistakenly applied entity_a's
        // field map ({code: immutable}) against entity_b's row, this would
        // fail because entity_b.code doesn't exist (violation would report
        // nothing) — but more importantly, we'd run a spurious get()
        // against entity_b and apply foreign metadata. The scoping guard
        // prevents this.
        return ctx.update("entity_b", "b-1", { note: "updated" });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("touch_b_via_a", { id: "a-1" }, actor);
    expect(result.success).toBe(true);
    const after = await dataProvider.get("entity_b", "b-1");
    expect(after.note).toBe("updated");
  });
});

// ── 7. Cross-type Date/string equivalence ─────────────────────────
//
// Round-5 P2: DrizzleDataProvider returns Date objects; HTTP/GraphQL
// clients send ISO strings. Without coercion, re-submitting an immutable
// datetime as a string would trip the check even when the timestamp is
// identical.

describe("Spec 63 — cross-type Date/string equivalence", () => {
  it("stored Date vs incoming ISO string with same timestamp is treated as unchanged", async () => {
    const entity: EntityDefinition = {
      name: "event_log",
      label: "Event",
      fields: {
        occurred_at: { type: "datetime", immutable: true },
        note: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    const storedTs = new Date("2024-06-15T10:00:00.000Z");
    await dataProvider.create("event_log", { id: "e-1", occurred_at: storedTs, note: "" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_event",
      entity: "event_log",
      label: "Update Event",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("event_log", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    // Client re-submits as ISO string of the SAME instant.
    const result = await executor.execute(
      "update_event",
      { id: "e-1", occurred_at: "2024-06-15T10:00:00.000Z", note: "touched" },
      actor,
    );
    expect(result.success).toBe(true);
  });

  it("stored Date vs incoming ISO string of a DIFFERENT timestamp is blocked", async () => {
    const entity: EntityDefinition = {
      name: "event_log_2",
      label: "Event",
      fields: {
        occurred_at: { type: "datetime", immutable: true },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("event_log_2", {
      id: "e-2",
      occurred_at: new Date("2024-06-15T10:00:00.000Z"),
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_event_2",
      entity: "event_log_2",
      label: "Update Event",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("event_log_2", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute(
      "update_event_2",
      { id: "e-2", occurred_at: "2025-01-01T00:00:00.000Z" },
      actor,
    );
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.immutable");
  });

  it("stored Date vs unparseable incoming string is treated as a change (blocked)", async () => {
    // Edge case: the coercion path rejects strings that don't parse to a
    // finite timestamp. A stored Date compared against "banana" must NOT
    // silently pass — it's a real value change that should trip immutable.
    const entity: EntityDefinition = {
      name: "event_log_3",
      label: "Event",
      fields: {
        occurred_at: { type: "datetime", immutable: true },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("event_log_3", {
      id: "e-3",
      occurred_at: new Date("2024-06-15T10:00:00.000Z"),
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_event_3",
      entity: "event_log_3",
      label: "Update Event",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("event_log_3", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    const result = await executor.execute(
      "update_event_3",
      { id: "e-3", occurred_at: "banana" },
      actor,
    );
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.immutable");
  });
});
