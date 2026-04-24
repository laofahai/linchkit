/**
 * Spec 63 Phase 1 — immutable field enforcement (including deprecated
 * `readonly: true` field-level alias).
 */

import { describe, expect, it } from "bun:test";
import type { EntityDefinition } from "../src/types/entity";
import { lockActor as actor, setupLockHarness as setup } from "./field-lock-helpers";

const purchaseEntity: EntityDefinition = {
  name: "purchase_request",
  fields: {
    code: { type: "string", immutable: true },
    title: { type: "string" },
    tags: { type: "json", immutable: true },
  },
};

describe("Spec 63 — immutable field enforcement", () => {
  it("blocks update that changes an immutable field with a non-null value", async () => {
    const { executor, dataProvider } = setup(purchaseEntity);
    await dataProvider.create("purchase_request", {
      id: "pr-1",
      code: "PR-001",
      title: "Original",
    });

    const result = await executor.execute("update_record", { id: "pr-1", code: "PR-002" }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
    expect(data.error).toBe("Cannot modify locked fields");
  });

  it("allows first assignment (existing value is null)", async () => {
    const { executor, dataProvider } = setup(purchaseEntity);
    await dataProvider.create("purchase_request", {
      id: "pr-2",
      code: null, // explicit null — first assignment path
      title: "Draft",
    });

    const result = await executor.execute("update_record", { id: "pr-2", code: "PR-NEW" }, actor);

    expect(result.success).toBe(true);
  });

  it("allows same-value re-write (no-op)", async () => {
    const { executor, dataProvider } = setup(purchaseEntity);
    await dataProvider.create("purchase_request", {
      id: "pr-3",
      code: "PR-003",
      title: "Original",
    });

    const result = await executor.execute(
      "update_record",
      { id: "pr-3", code: "PR-003", title: "Updated" },
      actor,
    );

    expect(result.success).toBe(true);
    const record = await dataProvider.get("purchase_request", "pr-3");
    expect(record.title).toBe("Updated");
  });

  it("blocks null-after-set on immutable field", async () => {
    const { executor, dataProvider } = setup(purchaseEntity);
    await dataProvider.create("purchase_request", {
      id: "pr-4",
      code: "PR-004",
    });

    const result = await executor.execute("update_record", { id: "pr-4", code: null }, actor);

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
  });

  it("uses JSON-equality for object/array immutable fields", async () => {
    const { executor, dataProvider } = setup(purchaseEntity);
    await dataProvider.create("purchase_request", {
      id: "pr-5",
      tags: ["a", "b"],
    });

    // Same content, new array instance — must be allowed
    const ok = await executor.execute("update_record", { id: "pr-5", tags: ["a", "b"] }, actor);
    expect(ok.success).toBe(true);

    // Changed content — blocked
    const blocked = await executor.execute(
      "update_record",
      { id: "pr-5", tags: ["a", "c"] },
      actor,
    );
    expect(blocked.success).toBe(false);
    const data = blocked.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
  });

  it("deprecated `readonly: true` behaves as alias for immutable", async () => {
    const legacyEntity: EntityDefinition = {
      name: "legacy_doc",
      fields: {
        doc_number: { type: "string", readonly: true },
        title: { type: "string" },
      },
    };
    const { executor, dataProvider } = setup(legacyEntity);
    await dataProvider.create("legacy_doc", {
      id: "d-1",
      doc_number: "DOC-1",
      title: "Old",
    });

    // Same value allowed
    const ok = await executor.execute(
      "update_record",
      { id: "d-1", doc_number: "DOC-1", title: "New" },
      actor,
    );
    expect(ok.success).toBe(true);

    // Different value blocked with immutable code (readonly is an alias)
    const blocked = await executor.execute(
      "update_record",
      { id: "d-1", doc_number: "DOC-2" },
      actor,
    );
    expect(blocked.success).toBe(false);
    const data = blocked.data as Record<string, unknown>;
    expect(data.code).toBe("validation.field.immutable");
  });
});
