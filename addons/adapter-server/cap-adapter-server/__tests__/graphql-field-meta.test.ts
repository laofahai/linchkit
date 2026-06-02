import { afterEach, describe, expect, test } from "bun:test";
import type { EntityDefinition, FieldOverlayRecord, LockCondition } from "@linchkit/core";
import { GraphQLNonNull, type GraphQLObjectType, graphql, printType } from "graphql";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import {
  buildFieldMetaList,
  clearFieldMetaTypeCache,
  getFieldMetaType,
  toLockConditionMeta,
} from "../src/graphql/field-meta";

// ── Fixture: an entity exercising every Phase-1 lock declaration ──
//  - code:     immutable (exempt from lockAllWhen via lockAllowFields, so it
//              demonstrates immutable-only with no inherited lock condition)
//  - legacy:   deprecated `readonly` alias (treated as immutable); also exempt
//  - amount:   per-field lockWhen with a positive state list
//  - supplier: per-field lockWhen with a { not } clause
//  - title:    no per-field lock → covered by entity-level lockAllWhen
//  - notes:    in lockAllowFields → exempt from lockAllWhen
//  - plain:    no lock at all (exempt from lockAllWhen)
//  - discount: per-field lockWhen with lockMode: "soft" (Spec 63 §4.2)
const orderSchema: EntityDefinition = {
  name: "purchase_order",
  label: "Purchase Order",
  lockAllWhen: { state: "posted" },
  lockAllowFields: ["notes", "code", "legacy", "plain"],
  fields: {
    code: { type: "string", immutable: true, label: "Code" },
    legacy: { type: "string", readonly: true, label: "Legacy" },
    amount: { type: "number", lockWhen: { state: ["submitted", "approved"] } },
    supplier: { type: "string", lockWhen: { state: { not: "draft" } } },
    title: { type: "string", label: "Title" },
    notes: { type: "text", label: "Notes" },
    plain: { type: "string", label: "Plain" },
    discount: { type: "number", lockWhen: { state: "posted" }, lockMode: "soft" },
  },
};

afterEach(() => {
  clearFieldMetaTypeCache();
});

// ── Pure builder: toLockConditionMeta ─────────────────────────────

describe("toLockConditionMeta", () => {
  test("positive single state → stateIn", () => {
    const meta = toLockConditionMeta({ state: "posted" });
    expect(meta.stateIn).toEqual(["posted"]);
    expect(meta.stateNotIn).toBeNull();
    expect(meta.domain).toBeNull();
    expect(JSON.parse(meta.raw)).toEqual({ state: "posted" });
  });

  test("positive state array → stateIn", () => {
    const meta = toLockConditionMeta({ state: ["submitted", "approved"] });
    expect(meta.stateIn).toEqual(["submitted", "approved"]);
    expect(meta.stateNotIn).toBeNull();
  });

  test("{ not: string } → stateNotIn", () => {
    const meta = toLockConditionMeta({ state: { not: "draft" } });
    expect(meta.stateNotIn).toEqual(["draft"]);
    expect(meta.stateIn).toBeNull();
  });

  test("{ not: string[] } → stateNotIn", () => {
    const meta = toLockConditionMeta({ state: { not: ["draft", "rejected"] } });
    expect(meta.stateNotIn).toEqual(["draft", "rejected"]);
  });

  test("domain clause is JSON-encoded and raw preserves authored shape", () => {
    const condition = { domain: [["amount", ">", 100]] } as const;
    const meta = toLockConditionMeta(condition);
    expect(meta.stateIn).toBeNull();
    expect(meta.stateNotIn).toBeNull();
    expect(JSON.parse(meta.domain ?? "null")).toEqual([["amount", ">", 100]]);
    expect(JSON.parse(meta.raw)).toEqual({ domain: [["amount", ">", 100]] });
  });

  test("malformed { not: undefined } does not throw → empty stateNotIn", () => {
    // A LockCondition whose `not` clause is undefined (empty/malformed `state`
    // object) must not crash introspection. The static type forbids this, so
    // we cast to exercise the runtime-drift guard.
    const condition = { state: { not: undefined } } as unknown as LockCondition;
    let meta: ReturnType<typeof toLockConditionMeta> | undefined;
    expect(() => {
      meta = toLockConditionMeta(condition);
    }).not.toThrow();
    expect(meta?.stateNotIn).toEqual([]);
    expect(meta?.stateIn).toBeNull();
  });

  test("empty state object {} does not throw → null lists", () => {
    // An empty `state` object has no `not` key at all → neither list applies.
    const condition = { state: {} } as unknown as LockCondition;
    let meta: ReturnType<typeof toLockConditionMeta> | undefined;
    expect(() => {
      meta = toLockConditionMeta(condition);
    }).not.toThrow();
    expect(meta?.stateNotIn).toBeNull();
    expect(meta?.stateIn).toBeNull();
  });
});

// ── Pure builder: buildFieldMetaList ──────────────────────────────

describe("buildFieldMetaList", () => {
  const list = buildFieldMetaList(orderSchema);
  const byName = new Map(list.map((m) => [m.name, m]));

  test("emits one meta per user-defined field", () => {
    expect(list.map((m) => m.name).sort()).toEqual(
      ["amount", "code", "discount", "legacy", "notes", "plain", "supplier", "title"].sort(),
    );
  });

  test("immutable field is flagged immutable with no lock condition", () => {
    const code = byName.get("code");
    expect(code?.immutable).toBe(true);
    expect(code?.lockWhen).toBeNull();
    expect(code?.lockSource).toBe("none");
  });

  test("deprecated readonly alias is reported as immutable", () => {
    expect(byName.get("legacy")?.immutable).toBe(true);
  });

  test("per-field lockWhen wins with source=field (positive list)", () => {
    const amount = byName.get("amount");
    expect(amount?.immutable).toBe(false);
    expect(amount?.lockSource).toBe("field");
    expect(amount?.lockWhen?.stateIn).toEqual(["submitted", "approved"]);
  });

  test("per-field lockWhen { not } projects to stateNotIn", () => {
    const supplier = byName.get("supplier");
    expect(supplier?.lockSource).toBe("field");
    expect(supplier?.lockWhen?.stateNotIn).toEqual(["draft"]);
  });

  test("uncovered field inherits entity lockAllWhen with source=entity", () => {
    const title = byName.get("title");
    expect(title?.lockSource).toBe("entity");
    expect(title?.lockWhen?.stateIn).toEqual(["posted"]);
  });

  test("lockAllowFields member is exempt from lockAllWhen", () => {
    const notes = byName.get("notes");
    expect(notes?.lockSource).toBe("none");
    expect(notes?.lockWhen).toBeNull();
  });

  test("field with no lock declaration has none", () => {
    const plain = byName.get("plain");
    expect(plain?.immutable).toBe(false);
    expect(plain?.lockWhen).toBeNull();
    expect(plain?.lockSource).toBe("none");
  });

  test("lockMode defaults to hard for immutable, conditional, and unlocked fields", () => {
    // immutable, per-field hard lock, and a plain unlocked field all → "hard".
    expect(byName.get("code")?.lockMode).toBe("hard");
    expect(byName.get("amount")?.lockMode).toBe("hard");
    expect(byName.get("plain")?.lockMode).toBe("hard");
  });

  test("lockMode: soft is surfaced for a soft conditional lock (Spec 63 §4.2)", () => {
    const discount = byName.get("discount");
    expect(discount?.lockSource).toBe("field");
    expect(discount?.lockWhen?.stateIn).toEqual(["posted"]);
    expect(discount?.lockMode).toBe("soft");
  });

  // Spec 63 §4.2 — `lockMode` governs the CONDITIONAL lock only. A stray
  // `lockMode: "soft"` on an immutable field, or on a field with no active lock,
  // must NOT introspect as soft (immutable is always hard; an unlocked field has
  // no soft semantics) — keeps GraphQL metadata aligned with runtime behavior and
  // with adapter-ui's field-lock-state.ts.
  test("lockMode: soft is ignored on immutable or unlocked fields", () => {
    const guarded: EntityDefinition = {
      name: "guarded",
      label: "Guarded",
      fields: {
        // immutable + soft declared → still hard (immutable wins, no conditional lock)
        frozen: { type: "string", immutable: true, lockMode: "soft" },
        // soft declared but NO lockWhen and no entity lockAllWhen → unlocked → hard
        loose: { type: "string", lockMode: "soft" },
        // soft + an actual conditional lock → genuinely soft
        editable: { type: "number", lockWhen: { state: "posted" }, lockMode: "soft" },
      },
    };
    const byField = new Map(buildFieldMetaList(guarded).map((m) => [m.name, m]));
    expect(byField.get("frozen")?.lockMode).toBe("hard");
    expect(byField.get("loose")?.lockMode).toBe("hard");
    expect(byField.get("editable")?.lockMode).toBe("soft");
  });

  test("active overlay fields are surfaced as unlocked, collisions skipped", () => {
    const overlays: FieldOverlayRecord[] = [
      {
        id: "ov1",
        entityName: "purchase_order",
        fieldName: "color",
        fieldType: "string",
        config: { label: { en: "Color" } },
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        // Collides with a code-defined field → must be skipped (mirrors the
        // type generator which also skips colliding overlays).
        id: "ov2",
        entityName: "purchase_order",
        fieldName: "amount",
        fieldType: "number",
        config: {},
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const withOverlays = buildFieldMetaList(orderSchema, overlays);
    const overlayMap = new Map(withOverlays.map((m) => [m.name, m]));

    // The new overlay field appears, reported as fully unlocked.
    const color = overlayMap.get("color");
    expect(color).toBeDefined();
    expect(color?.immutable).toBe(false);
    expect(color?.lockWhen).toBeNull();
    expect(color?.lockSource).toBe("none");
    // Overlays cannot lock a field → conditional lock mode is the default "hard".
    expect(color?.lockMode).toBe("hard");

    // The colliding overlay does NOT add a duplicate; "amount" keeps its
    // code-declared per-field lock.
    expect(withOverlays.filter((m) => m.name === "amount")).toHaveLength(1);
    expect(overlayMap.get("amount")?.lockSource).toBe("field");

    // Code-defined fields are unaffected in count; only "color" is added.
    expect(withOverlays.length).toBe(list.length + 1);
  });
});

// ── Schema shape: the FieldMeta GraphQL type exists ───────────────

describe("FieldMeta GraphQL type", () => {
  test("FieldMeta type has the spec §6 fields with correct nullability", () => {
    const type = getFieldMetaType();
    const fields = type.getFields();
    expect(fields.name.type).toBeInstanceOf(GraphQLNonNull);
    expect(fields.immutable.type).toBeInstanceOf(GraphQLNonNull);
    expect(fields.lockSource.type).toBeInstanceOf(GraphQLNonNull);
    // lockMode is a non-null string ("hard" | "soft")
    expect(fields.lockMode.type).toBeInstanceOf(GraphQLNonNull);
    // lockWhen is nullable (no NonNull wrapper) — fields without a lock are null
    expect(fields.lockWhen.type).not.toBeInstanceOf(GraphQLNonNull);
    // sanity: printable without throwing
    expect(printType(type)).toContain("type FieldMeta");
  });
});

// ── End-to-end: query the real built schema ───────────────────────

describe("buildGraphQLSchema exposes <entity>FieldMeta", () => {
  // No dataProvider — field-meta is pure static metadata and must resolve
  // even in mock mode. Exercises the real build-schema path.
  const schema = buildGraphQLSchema([orderSchema]);

  test("Query exposes a purchaseOrderFieldMeta field returning [FieldMeta!]!", () => {
    const queryType = schema.getQueryType() as GraphQLObjectType;
    const field = queryType.getFields().purchaseOrderFieldMeta;
    expect(field).toBeDefined();
    // [FieldMeta!]! — outer NonNull
    expect(field.type).toBeInstanceOf(GraphQLNonNull);
  });

  test("introspected metadata matches the declared locks", async () => {
    const result = await graphql({
      schema,
      source: `
        query {
          purchaseOrderFieldMeta {
            name
            immutable
            lockSource
            lockMode
            lockWhen {
              stateIn
              stateNotIn
              domain
              raw
            }
          }
        }
      `,
    });

    expect(result.errors).toBeUndefined();
    const metas = (result.data?.purchaseOrderFieldMeta ?? []) as Array<{
      name: string;
      immutable: boolean;
      lockSource: string;
      lockMode: string;
      lockWhen: {
        stateIn: string[] | null;
        stateNotIn: string[] | null;
        domain: string | null;
        raw: string;
      } | null;
    }>;
    const byName = new Map(metas.map((m) => [m.name, m]));

    // immutable
    expect(byName.get("code")?.immutable).toBe(true);
    expect(byName.get("code")?.lockWhen).toBeNull();
    expect(byName.get("code")?.lockMode).toBe("hard");

    // soft conditional lock surfaces lockMode: "soft"
    expect(byName.get("discount")?.lockSource).toBe("field");
    expect(byName.get("discount")?.lockMode).toBe("soft");

    // per-field positive lockWhen
    expect(byName.get("amount")?.lockSource).toBe("field");
    expect(byName.get("amount")?.lockWhen?.stateIn).toEqual(["submitted", "approved"]);

    // per-field { not } lockWhen
    expect(byName.get("supplier")?.lockWhen?.stateNotIn).toEqual(["draft"]);

    // entity-level lockAllWhen inherited
    expect(byName.get("title")?.lockSource).toBe("entity");
    expect(byName.get("title")?.lockWhen?.stateIn).toEqual(["posted"]);

    // lockAllowFields exemption
    expect(byName.get("notes")?.lockSource).toBe("none");
    expect(byName.get("notes")?.lockWhen).toBeNull();

    // raw preserves the authored condition verbatim
    expect(JSON.parse(byName.get("amount")?.lockWhen?.raw ?? "null")).toEqual({
      state: ["submitted", "approved"],
    });
  });
});
