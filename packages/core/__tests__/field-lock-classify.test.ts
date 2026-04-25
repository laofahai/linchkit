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

// ── 6c. Translatable field same-value normalization ──────────────
// Round-7 P2: providers that store i18n content as locale maps return
// the raw `{ locale: value }` object when no execution locale is set,
// while clients submit a plain string. Treat the string as unchanged
// when it equals any locale value in the existing map.

describe("Spec 63 — translatable field same-value normalization", () => {
  it("immutable translatable field re-submitted as a string matching a locale value succeeds", async () => {
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
    // DB stores locale map (typical Drizzle layout for translatable JSONB).
    await dataProvider.create("label_doc", {
      id: "ld-1",
      title: { en: "Hello", zh: "你好" },
      notes: "",
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

    // Caller sends "Hello" — matches existing.en → unchanged.
    const result = await executor.execute(
      "update_label",
      { id: "ld-1", title: "Hello", notes: "edited" },
      actor,
    );
    expect(result.success).toBe(true);
  });

  it("immutable translatable field with a NEW string value still blocks", async () => {
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
      id: "ld-2",
      title: { en: "Hello", zh: "你好" },
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

    // Caller sends "Greetings" — matches no existing locale value.
    const result = await executor.execute(
      "update_label_2",
      { id: "ld-2", title: "Greetings" },
      actor,
    );
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).code).toBe("validation.field.immutable");
  });
});
