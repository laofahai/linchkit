/**
 * Spec 63 Phase 1 — lockWhen, lockAllWhen, error shape, bulk per-record.
 *
 * Immutable enforcement has its own file (field-lock-immutable.test.ts).
 */

import { describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import {
  lockActor as actor,
  createMemoryDataProvider,
  setupLockHarness as setup,
} from "./field-lock-helpers";

// ── Per-field lockWhen ─────────────────────────────────────

describe("Spec 63 — per-field lockWhen", () => {
  const entity: EntityDefinition = {
    name: "purchase_request",
    fields: {
      status: { type: "string" },
      amount: { type: "number", lockWhen: { state: "submitted" } },
      supplier: { type: "string", lockWhen: { state: ["submitted", "approved"] } },
      reviewer: { type: "string", lockWhen: { state: { not: "draft" } } },
      notes: { type: "text" },
    },
  };

  it("blocks update when status matches the single-state lock", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "p-1",
      status: "submitted",
      amount: 100,
    });

    const result = await executor.execute("update_record", { id: "p-1", amount: 200 }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.locked");
    const context = data.context as Record<string, unknown>;
    expect(context.field).toBe("amount");
  });

  it("blocks update when status matches any array-form lock state", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "p-2",
      status: "approved",
      supplier: "ACME",
    });

    const result = await executor.execute("update_record", { id: "p-2", supplier: "OTHER" }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.locked");
  });

  it("blocks update when status is anything other than excluded (not form)", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "p-3",
      status: "submitted",
      reviewer: "alice",
    });

    const result = await executor.execute("update_record", { id: "p-3", reviewer: "bob" }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.locked");
  });

  it("allows update when lockWhen condition does not match", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "p-4",
      status: "draft",
      amount: 100,
      supplier: "ACME",
      reviewer: "alice",
    });

    const result = await executor.execute(
      "update_record",
      { id: "p-4", amount: 200, supplier: "OTHER", reviewer: "bob" },
      actor,
    );

    expect(result.success).toBe(true);
  });

  it("allows update on fields without lockWhen even in locked state", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "p-5",
      status: "submitted",
      notes: "old notes",
    });

    const result = await executor.execute(
      "update_record",
      { id: "p-5", notes: "new notes" },
      actor,
    );

    expect(result.success).toBe(true);
  });
});

// ── Entity-level lockAllWhen + lockAllowFields ─────────────

describe("Spec 63 — lockAllWhen + lockAllowFields", () => {
  const invoiceEntity: EntityDefinition = {
    name: "invoice",
    lockAllWhen: { state: "posted" },
    lockAllowFields: ["notes", "tags"],
    fields: {
      status: { type: "string" },
      amount: { type: "number" },
      supplier: { type: "string" },
      notes: { type: "text" },
      tags: { type: "json" },
    },
  };

  it("lockAllWhen locks all non-allowlisted fields in matching state", async () => {
    const { executor, dataProvider } = setup(invoiceEntity);
    await dataProvider.create("invoice", {
      id: "inv-1",
      status: "posted",
      amount: 100,
    });

    const result = await executor.execute("update_record", { id: "inv-1", amount: 200 }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.locked");
  });

  it("lockAllowFields exempts listed fields from the entity-level lock", async () => {
    const { executor, dataProvider } = setup(invoiceEntity);
    await dataProvider.create("invoice", {
      id: "inv-2",
      status: "posted",
      notes: "old",
      tags: ["x"],
    });

    const result = await executor.execute(
      "update_record",
      { id: "inv-2", notes: "new", tags: ["y"] },
      actor,
    );

    expect(result.success).toBe(true);
  });

  it("per-field lockWhen overrides lockAllWhen (field not in allowlist still uses own condition)", async () => {
    const overrideEntity: EntityDefinition = {
      name: "override_case",
      lockAllWhen: { state: "posted" },
      fields: {
        status: { type: "string" },
        // draft-only lock — diverges from the entity-level rule (posted)
        early_lock: { type: "string", lockWhen: { state: "draft" } },
        default_lock: { type: "string" },
      },
    };
    const { executor, dataProvider } = setup(overrideEntity);

    // In "posted" state: default_lock falls back to lockAllWhen (blocked),
    // but early_lock's per-field condition requires "draft", so posted
    // does NOT trigger that per-field lock → early_lock is editable.
    await dataProvider.create("override_case", {
      id: "oc-1",
      status: "posted",
      early_lock: "A",
      default_lock: "A",
    });
    const postedResult = await executor.execute(
      "update_record",
      { id: "oc-1", early_lock: "B" },
      actor,
    );
    expect(postedResult.success).toBe(true);

    // Updating a field that falls back to lockAllWhen fails in "posted".
    const blockedResult = await executor.execute(
      "update_record",
      { id: "oc-1", default_lock: "B" },
      actor,
    );
    expect(blockedResult.success).toBe(false);

    // In "draft" state: early_lock's per-field rule fires; default_lock
    // escapes the entity-level rule (posted only) → default_lock editable.
    await dataProvider.update("override_case", "oc-1", { status: "draft" });
    const draftResult = await executor.execute(
      "update_record",
      { id: "oc-1", early_lock: "C" },
      actor,
    );
    expect(draftResult.success).toBe(false);
    const defaultEditable = await executor.execute(
      "update_record",
      { id: "oc-1", default_lock: "C" },
      actor,
    );
    expect(defaultEditable.success).toBe(true);
  });
});

// ── Error shape + edge cases + bulk ────────────────────────

describe("Spec 63 — error response shape and edge cases", () => {
  const entity: EntityDefinition = {
    name: "purchase_request",
    fields: {
      status: { type: "string" },
      code: { type: "string", immutable: true },
      amount: { type: "number", lockWhen: { state: "submitted" } },
      supplier: { type: "string", lockWhen: { state: "submitted" } },
      notes: { type: "text" },
    },
  };

  it("lock violation returns `validation.field.locked` code and details array", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "r-1",
      status: "submitted",
      amount: 100,
    });

    const result = await executor.execute("update_record", { id: "r-1", amount: 200 }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.locked");
    expect(data.error).toBe("Cannot modify locked fields");
    const details = data.details as Array<{ field: string; type: string; message: string }>;
    expect(details).toHaveLength(1);
    expect(details[0].field).toBe("amount");
    expect(details[0].type).toBe("locked");
    expect(details[0].message).toMatch(/locked/i);
    const ctx = data.context as Record<string, unknown>;
    expect(ctx.field).toBe("amount");
    expect(ctx.constraint).toBe("locked");
  });

  it("immutable violation returns `validation.field.immutable` code", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "r-2",
      status: "draft",
      code: "C1",
    });

    const result = await executor.execute("update_record", { id: "r-2", code: "C2" }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
    const ctx = data.context as Record<string, unknown>;
    expect(ctx.constraint).toBe("immutable");
  });

  it("skips lock check for create (no existing record)", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider, entityRegistry });

    const createAction: ActionDefinition = {
      name: "create_record",
      entity: entity.name,
      label: "Create",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => ctx.create(entity.name, ctx.input),
    };
    executor.registry.register(createAction);

    // No `id` in input → no existing record fetch → immutable/lock not evaluated
    const result = await executor.execute(
      "create_record",
      { status: "submitted", code: "C", amount: 100 },
      actor,
    );

    expect(result.success).toBe(true);
  });

  it("reports all violations when multiple locked fields are touched in one update", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "r-3",
      status: "submitted",
      amount: 100,
      supplier: "ACME",
    });

    const result = await executor.execute(
      "update_record",
      { id: "r-3", amount: 200, supplier: "OTHER" },
      actor,
    );

    expect(result.success).toBe(false);
    const details = (result.data as Record<string, unknown>).details as Array<{
      field: string;
      type: string;
    }>;
    const fields = details.map((d) => d.field).sort();
    expect(fields).toEqual(["amount", "supplier"]);
  });

  it("ignores input fields not present in the entity definition", async () => {
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "r-4",
      status: "submitted",
      notes: "ok",
    });

    // `random_field` is not declared on the entity — the checker must skip it
    // rather than throw. The handler will still fail on downstream write if
    // the field is invalid, but lock enforcement does not.
    const result = await executor.execute(
      "update_record",
      { id: "r-4", notes: "updated", random_field: "anything" },
      actor,
    );

    expect(result.success).toBe(true);
  });

  it("skips lock check when no entityRegistry is provided", async () => {
    // Engine must degrade gracefully when the EntityRegistry isn't wired —
    // tests that don't care about locking should still be able to run.
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });

    const action: ActionDefinition = {
      name: "update_record",
      entity: "purchase_request",
      label: "Update",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const id = ctx.input.id as string;
        const { id: _id, ...rest } = ctx.input as Record<string, unknown>;
        return ctx.update("purchase_request", id, rest);
      },
    };
    executor.registry.register(action);

    await dataProvider.create("purchase_request", {
      id: "x-1",
      status: "submitted",
      code: "C1",
    });

    // Would be blocked if entityRegistry was supplied; without it the engine
    // skips the check entirely.
    const result = await executor.execute("update_record", { id: "x-1", code: "C2" }, actor);

    expect(result.success).toBe(true);
  });
});

// ── Bulk (per-record) lock enforcement ─────────────────────

describe("Spec 63 — bulk per-record lock state", () => {
  const entity: EntityDefinition = {
    name: "purchase_request",
    fields: {
      status: { type: "string" },
      amount: { type: "number", lockWhen: { state: "submitted" } },
    },
  };

  it("each record is evaluated independently based on its own state", async () => {
    // Spec 63 §7.4 — bulk operations must check per record. The Action Engine
    // runs one execution per id, so we verify the executor produces different
    // outcomes for different records in the same "bulk" call sequence.
    const { executor, dataProvider } = setup(entity);
    await dataProvider.create("purchase_request", {
      id: "b-1",
      status: "draft",
      amount: 100,
    });
    await dataProvider.create("purchase_request", {
      id: "b-2",
      status: "submitted",
      amount: 200,
    });

    const results = await Promise.all([
      executor.execute("update_record", { id: "b-1", amount: 150 }, actor),
      executor.execute("update_record", { id: "b-2", amount: 250 }, actor),
    ]);

    // Different per-record outcomes — b-1 (draft) succeeds, b-2 (submitted) is locked
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    const data1 = results[1].data as Record<string, unknown>;
    expect(data1.code).toBe("validation.field.locked");
  });
});
