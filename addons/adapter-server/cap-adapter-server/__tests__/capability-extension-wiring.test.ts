/**
 * END-TO-END guardrail for capability extension wiring (the Odoo `_inherit`
 * model for entities + views).
 *
 * Before this wiring existed, `cap.extensions.entities` / `cap.extensions.views`
 * were dead data: the types, the `extendEntity`/`extendView` helpers and the
 * registry merge logic all existed and were unit-tested, but NO boot path ever
 * read them. This suite proves the field added by an extension capability is
 * visible END-TO-END through the dev:server assembly:
 *
 *   1. the entity registry resolve() surfaces the added field,
 *   2. the built GraphQL schema's `Partner` type exposes it (the assertion that
 *      catches a half-wired fix — GraphQL reads RAW `entity.fields`, not the
 *      resolved entity), and
 *   3. the view extension is applied to the contributed view that the
 *      `/api/entities/:name` endpoint serves.
 *
 * DB-free, port-free: `assembleDevSchema` falls back to InMemoryStore and we
 * never call `app.listen` (which segfaults the batched runner). The GraphQL
 * schema is introspected in-process via `graphqlSync`.
 */

import { describe, expect, it } from "bun:test";
import {
  type CapabilityDefinition,
  defineCapability,
  defineView,
  extendEntity,
  extendView,
} from "@linchkit/core";
import {
  getIntrospectionQuery,
  graphqlSync,
  type IntrospectionObjectType,
  type IntrospectionQuery,
} from "graphql";
import { assembleDevSchema } from "../src/assemble-schema";
import { capAdapterServer } from "../src/capability";

// ── Fixture: base capability (the entity being extended) ───────────────────

const capFixtureBase: CapabilityDefinition = defineCapability({
  name: "cap-fixture-base",
  label: "Fixture Base",
  description: "Defines the `partner` entity + its form/list views (no layout)",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [
    {
      name: "partner",
      label: "Partner",
      fields: {
        name: { type: "string", required: true, label: "Name" },
        email: { type: "string", label: "Email" },
      },
    },
  ],
  views: [
    defineView({
      name: "partner_form",
      entity: "partner",
      type: "form",
      // No explicit `layout` — renders from fields[].
      fields: [{ field: "name" }, { field: "email" }],
    }),
    defineView({
      name: "partner_list",
      entity: "partner",
      type: "list",
      fields: [{ field: "name" }, { field: "email" }],
    }),
  ],
});

// ── Fixture: extension capability (patches base in place) ──────────────────

const capFixtureExt: CapabilityDefinition = defineCapability({
  name: "cap-fixture-ext",
  label: "Fixture Extension",
  description: "Adds `credit_limit` to `partner` + its form view (the `_inherit` model)",
  type: "bridge",
  category: "business",
  version: "0.1.0",
  extensions: {
    entities: [
      extendEntity("partner", {
        fields: { credit_limit: { type: "number", label: "Credit Limit" } },
      }),
    ],
    views: [extendView("partner_form", { addFields: [{ field: "credit_limit" }] })],
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Introspect a built schema and return the named object type, or undefined. */
function introspectType(
  schema: ReturnType<typeof assembleDevSchema>["schema"],
  typeName: string,
): IntrospectionObjectType | undefined {
  const result = graphqlSync({ schema, source: getIntrospectionQuery() });
  expect(result.errors).toBeUndefined();
  const data = result.data as unknown as IntrospectionQuery;
  const type = data.__schema.types.find((t) => t.name === typeName);
  return type?.kind === "OBJECT" ? (type as IntrospectionObjectType) : undefined;
}

// ── Suite ────────────────────────────────────────────────────────────────

describe("capability extension wiring (dev:server path, end-to-end)", () => {
  it("entity registry resolve('partner') surfaces the extension field", () => {
    const assembled = assembleDevSchema([capAdapterServer, capFixtureBase, capFixtureExt]);
    const resolved = assembled.runtime.entityRegistry.resolve("partner");
    expect(Object.keys(resolved.fields)).toContain("credit_limit");
    expect(resolved.fields.credit_limit?.definition.type).toBe("number");
  });

  it("the contributions entity list carries the merged field (raw fields)", () => {
    const assembled = assembleDevSchema([capAdapterServer, capFixtureBase, capFixtureExt]);
    const partner = assembled.contributions.entities.find((e) => e.name === "partner");
    expect(partner).toBeDefined();
    expect(Object.keys(partner?.fields ?? {})).toContain("credit_limit");
  });

  it("the built GraphQL `Partner` type exposes `credit_limit`", () => {
    const assembled = assembleDevSchema([capAdapterServer, capFixtureBase, capFixtureExt]);
    const partnerType = introspectType(assembled.schema, "Partner");
    expect(partnerType).toBeDefined();
    const fieldNames = (partnerType?.fields ?? []).map((f) => f.name);
    // toCamelCase leaves snake_case field names as-is in the GraphQL object type.
    expect(fieldNames).toContain("credit_limit");
  });

  it("the contributed `partner_form` view gains the `credit_limit` field entry", () => {
    const assembled = assembleDevSchema([capAdapterServer, capFixtureBase, capFixtureExt]);
    const form = assembled.contributions.views.find((v) => v.name === "partner_form");
    expect(form).toBeDefined();
    expect(form?.fields.map((f) => f.field)).toEqual(["name", "email", "credit_limit"]);
    // The list view (not targeted) is untouched.
    const list = assembled.contributions.views.find((v) => v.name === "partner_list");
    expect(list?.fields.map((f) => f.field)).toEqual(["name", "email"]);
  });
});
