/**
 * Spec 63 Phase 1 — cross-entity scoping, deterministic classification,
 * translatable same-value normalization (Codex rounds 6 & 7).
 */

import { describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import { lockActor as actor, createMemoryDataProvider } from "./field-lock-helpers";

// ── 6. Cross-entity ctx.update enforces TARGET entity's locks ──────
//
// Round-6 fix: the wrapper resolves the target entity from the registry on
// every ctx.update() call and applies that entity's own immutable /
// lockWhen / lockAllWhen rules. A handler can't bypass Spec 63 by writing
// to a related entity. Entities without lock metadata (or unregistered
// entities) are silently skipped — the check is opt-in via metadata.

describe("Spec 63 — cross-entity ctx.update enforces the target entity's locks", () => {
  it("writing to an unrelated entity with no lock metadata still succeeds", async () => {
    // Entity A: has an immutable field. Entity B: no lock metadata.
    const entityA: EntityDefinition = {
      name: "entity_a",
      label: "A",
      fields: {
        code: { type: "string", immutable: true },
      },
    };
    const entityB: EntityDefinition = {
      name: "entity_b",
      label: "B",
      fields: {
        note: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entityA);
    entityRegistry.register(entityB);

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
        // Cross-entity write — entity_b has no lock metadata, so the
        // wrapper is a no-op for this call.
        return ctx.update("entity_b", "b-1", { note: "updated" });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("touch_b_via_a", { id: "a-1" }, actor);
    expect(result.success).toBe(true);
    const after = await dataProvider.get("entity_b", "b-1");
    expect(after.note).toBe("updated");
  });

  it("blocks cross-entity write that violates the TARGET entity's immutable", async () => {
    // Entity A: workflow entity. Entity B: has an immutable field.
    const entityA: EntityDefinition = {
      name: "entity_a",
      label: "A",
      fields: { trigger: { type: "string" } },
    };
    const entityB: EntityDefinition = {
      name: "entity_b",
      label: "B",
      fields: {
        external_ref: { type: "string", immutable: true },
        note: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entityA);
    entityRegistry.register(entityB);

    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("entity_a", { id: "a-1", trigger: "go" });
    await dataProvider.create("entity_b", { id: "b-1", external_ref: "ORIG", note: "" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "spoof_b_via_a",
      entity: "entity_a",
      label: "Spoof B via A",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        // Action targets entity_a but the handler tries to mutate B's
        // immutable external_ref. Round-6 fix: this MUST be blocked by
        // entity_b's own lock metadata.
        return ctx.update("entity_b", "b-1", { external_ref: "FORGED" });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("spoof_b_via_a", { id: "a-1" }, actor);
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.immutable");
    // And the actual write didn't happen.
    const after = await dataProvider.get("entity_b", "b-1");
    expect(after.external_ref).toBe("ORIG");
  });
});

// ── 6b. Mixed-type violations classify deterministically ──────────────
//
// Round-6 P2: when a single update mutates BOTH an immutable field and a
// state-locked field, the top-level error code must not depend on caller
// input key order. Immutable wins (more specific, permanent rule).

describe("Spec 63 — mixed immutable + locked violations classify deterministically", () => {
  it("immutable wins over lockWhen regardless of input key order", async () => {
    const entity: EntityDefinition = {
      name: "mixed",
      label: "Mixed",
      fields: {
        code: { type: "string", immutable: true },
        amount: { type: "number", lockWhen: { state: "submitted" } },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("mixed", {
      id: "m-1",
      code: "X",
      amount: 100,
      status: "submitted",
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_mixed",
      entity: "mixed",
      label: "Update Mixed",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("mixed", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    // Order A: immutable first, then locked.
    const r1 = await executor.execute("update_mixed", { id: "m-1", code: "Y", amount: 200 }, actor);
    expect(r1.success).toBe(false);
    expect((r1.data as Record<string, unknown>).code).toBe("validation.field.immutable");

    // Order B: locked first, then immutable. Same code.
    const r2 = await executor.execute("update_mixed", { id: "m-1", amount: 300, code: "Z" }, actor);
    expect(r2.success).toBe(false);
    expect((r2.data as Record<string, unknown>).code).toBe("validation.field.immutable");
  });
});

// ── 6c. Translatable field same-value normalization (Phase 2 work) ──
// Round-7's "any-locale match = unchanged" was over-permissive: a caller
// could change an immutable translatable field by submitting another
// locale's existing value (which then silently overwrites the active
// locale). Properly fixing this needs the active write locale to flow
// into the checker. Until then (Phase 2), plain-string vs locale-map
// mismatches fall through to structural equality and surface as
// violations. Clients should submit the full locale map for translatable
// updates.

describe("Spec 63 — translatable field locale-map vs plain-string update", () => {
  it("plain-string update on immutable translatable map is rejected (Phase 1 limitation)", async () => {
    const entity: EntityDefinition = {
      name: "label_doc",
      label: "Label Doc",
      fields: {
        title: { type: "string", translatable: true, immutable: true },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("label_doc", {
      id: "ld-1",
      title: { en: "Hello", zh: "你好" },
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_label",
      entity: "label_doc",
      label: "Update Label",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("label_doc", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    // Caller sends "Hello" (matches existing.en) — but Phase 1 cannot
    // normalize: structural map-vs-string is not equal.
    const result = await executor.execute("update_label", { id: "ld-1", title: "Hello" }, actor);
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.immutable");
  });

  it("immutable translatable field with full locale-map round-trip succeeds", async () => {
    const entity: EntityDefinition = {
      name: "label_doc",
      label: "Label Doc",
      fields: {
        title: { type: "string", translatable: true, immutable: true },
        notes: { type: "string" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("label_doc", {
      id: "ld-2",
      title: { en: "Hello", zh: "你好" },
      notes: "",
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "update_label_2",
      entity: "label_doc",
      label: "Update Label",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        const { id: _id, ...rest } = ctx.input;
        return ctx.update("label_doc", ctx.input.id as string, rest);
      },
    } satisfies ActionDefinition);

    // Caller submits the full locale map unchanged — structural equality
    // recognizes it as a no-op.
    const result = await executor.execute(
      "update_label_2",
      { id: "ld-2", title: { en: "Hello", zh: "你好" }, notes: "edited" },
      actor,
    );
    expect(result.success).toBe(true);
  });
});

// ── Codex round-9: handler-path status transitions exempt from lockAllWhen ─
// Spec 63 §7.1 — state transitions change the locked field set
// automatically, so `status` writes must succeed even while `lockAllWhen`
// matches. The declarative path already strips `status` from its
// preflight; the handler `ctx.update` wrapper now mirrors that via the
// SYSTEM_FIELD_NAMES exemption.

describe("Spec 63 — handler-path ctx.update on status is exempt from lockAllWhen", () => {
  it("handler that writes only status succeeds even when lockAllWhen matches", async () => {
    const entity: EntityDefinition = {
      name: "wf_lockall",
      label: "Workflow",
      lockAllWhen: { state: "submitted" },
      fields: {
        amount: { type: "number" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("wf_lockall", { id: "w-1", amount: 100, status: "submitted" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "approve_wf",
      entity: "wf_lockall",
      label: "Approve",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        // Handler-path state transition. Without the status exemption,
        // lockAllWhen: { state: "submitted" } would refuse to let us
        // leave the submitted state — making transitions impossible.
        return ctx.update("wf_lockall", ctx.input.id as string, { status: "approved" });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("approve_wf", { id: "w-1" }, actor);
    expect(result.success).toBe(true);
    const after = await dataProvider.get("wf_lockall", "w-1");
    expect(after.status).toBe("approved");
  });

  it("declarative stateTransition still respects an explicit lockWhen on status", async () => {
    // Round-10 fix: the declarative path was unconditionally stripping
    // `status` from the lock check, bypassing schema-author per-field
    // locks. Now status flows into checkFieldLocks; SYSTEM_FIELD_NAMES
    // only exempts status from lockAllWhen, not from per-field lockWhen.
    const entity: EntityDefinition = {
      name: "doc_locked_status",
      label: "Doc",
      fields: {
        // Schema author: "once posted, status itself is frozen — no
        // further transitions allowed even via setFields/stateTransition".
        status: { type: "string", lockWhen: { state: "posted" } },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("doc_locked_status", { id: "dls-1", status: "posted" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "decl_revert",
      entity: "doc_locked_status",
      label: "Revert",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      stateTransition: { from: "posted", to: "draft" },
    } satisfies ActionDefinition);

    const result = await executor.execute("decl_revert", { id: "dls-1" }, actor);
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.locked");
  });

  it("explicit per-field lockWhen on status still applies", async () => {
    // An explicit lockWhen on `status` is intentional (e.g., "freeze the
    // status column once posted, no further transitions allowed"). The
    // SYSTEM_FIELD_NAMES exemption is for lockAllWhen only.
    const entity: EntityDefinition = {
      name: "wf_explicit",
      label: "Workflow",
      fields: {
        status: { type: "string", lockWhen: { state: "posted" } },
        amount: { type: "number" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("wf_explicit", { id: "we-1", amount: 100, status: "posted" });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "force_status_change",
      entity: "wf_explicit",
      label: "Force Status",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        return ctx.update("wf_explicit", ctx.input.id as string, { status: "draft" });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("force_status_change", { id: "we-1" }, actor);
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.locked");
  });
});

// ── Codex round-8: deleted_at exempt from lockAllWhen ─────────────
// `deleted_at` is the soft-delete marker. EntityRegistry.resolve()
// doesn't inject it as a regular field; generated `restore_*` actions
// write it via ctx.update. Treating it as a system field keeps
// restore working on records governed by lockAllWhen.

describe("Spec 63 — deleted_at exempt from lockAllWhen", () => {
  it("restore-style update (deleted_at: null) succeeds even when lockAllWhen matches", async () => {
    const entity: EntityDefinition = {
      name: "doc_softdel",
      label: "Doc",
      lockAllWhen: { state: "posted" },
      fields: {
        amount: { type: "number" },
      },
    };
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(entity);
    const dataProvider = createMemoryDataProvider();
    await dataProvider.create("doc_softdel", {
      id: "ds-1",
      amount: 100,
      status: "posted",
      deleted_at: new Date(),
    });

    const executor = createActionExecutor({ dataProvider, entityRegistry });
    executor.registry.register({
      name: "restore_doc",
      entity: "doc_softdel",
      label: "Restore Doc",
      input: { id: { type: "string", required: true } },
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        return ctx.update("doc_softdel", ctx.input.id as string, { deleted_at: null });
      },
    } satisfies ActionDefinition);

    const result = await executor.execute("restore_doc", { id: "ds-1" }, actor);
    expect(result.success).toBe(true);
  });
});
