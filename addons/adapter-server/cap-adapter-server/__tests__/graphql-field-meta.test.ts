import { afterEach, describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core";
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
});

// ── Pure builder: buildFieldMetaList ──────────────────────────────

describe("buildFieldMetaList", () => {
  const list = buildFieldMetaList(orderSchema);
  const byName = new Map(list.map((m) => [m.name, m]));

  test("emits one meta per user-defined field", () => {
    expect(list.map((m) => m.name).sort()).toEqual(
      ["amount", "code", "legacy", "notes", "plain", "supplier", "title"].sort(),
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
});

// ── Schema shape: the FieldMeta GraphQL type exists ───────────────

describe("FieldMeta GraphQL type", () => {
  test("FieldMeta type has the spec §6 fields with correct nullability", () => {
    const type = getFieldMetaType();
    const fields = type.getFields();
    expect(fields.name.type).toBeInstanceOf(GraphQLNonNull);
    expect(fields.immutable.type).toBeInstanceOf(GraphQLNonNull);
    expect(fields.lockSource.type).toBeInstanceOf(GraphQLNonNull);
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
