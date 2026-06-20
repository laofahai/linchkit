/**
 * Headless proof for the cap-partner + cap-sales in-place extension demo.
 *
 * This is the deterministic, DB-free, port-free guard that runs BEFORE the live
 * browser e2e (e2e/browser/partner-extension.test.ts). It imports the REAL demo
 * capability modules (the same ones config/capabilities.ts registers) and the
 * REAL `assembleDevSchema` — the exact assembly `bun run dev:server` exercises,
 * minus starting the HTTP server — and proves the `credit_limit` field added by
 * cap-sales is visible END-TO-END through every downstream consumer:
 *
 *   1. the entity registry resolve('partner') surfaces it (type number),
 *   2. the built GraphQL `Partner` type exposes it (GraphQL reads RAW
 *      `entity.fields`, so this catches a half-wired fix), and
 *   3. the contributed `partner_form` view gains the field — while the
 *      untargeted `partner_list` view stays untouched.
 *
 * Modelled on
 * addons/adapter-server/cap-adapter-server/__tests__/capability-extension-wiring.test.ts,
 * but against the SHIPPED demo modules rather than inline fixtures. In-process
 * only (`graphqlSync` introspection); NEVER `app.listen` (segfaults the batched
 * runner). `assembleDevSchema` falls back to InMemoryStore so it needs no DB.
 */

import { describe, expect, it } from "bun:test";
import { assembleDevSchema, capAdapterServer } from "@linchkit/cap-adapter-server";
import {
  getIntrospectionQuery,
  graphqlSync,
  type IntrospectionObjectType,
  type IntrospectionQuery,
} from "graphql";
import { partnerCapability } from "../partner";
import { salesCapability } from "../sales";

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

describe("cap-partner + cap-sales in-place extension (dev:server path, end-to-end)", () => {
  it("entity registry resolve('partner') surfaces the cap-sales credit_limit field", () => {
    const assembled = assembleDevSchema([capAdapterServer, partnerCapability, salesCapability]);
    const resolved = assembled.runtime.entityRegistry.resolve("partner");
    expect(Object.keys(resolved.fields)).toContain("credit_limit");
    expect(resolved.fields.credit_limit?.definition.type).toBe("number");
  });

  it("the built GraphQL `Partner` type exposes credit_limit", () => {
    const assembled = assembleDevSchema([capAdapterServer, partnerCapability, salesCapability]);
    const partnerType = introspectType(assembled.schema, "Partner");
    expect(partnerType).toBeDefined();
    const fieldNames = (partnerType?.fields ?? []).map((f) => f.name);
    // toCamelCase leaves snake_case field names as-is in the GraphQL object type.
    expect(fieldNames).toContain("credit_limit");
  });

  it("the contributed `partner_form` view gains credit_limit; `partner_list` is untouched", () => {
    const assembled = assembleDevSchema([capAdapterServer, partnerCapability, salesCapability]);

    const form = assembled.contributions.views.find((v) => v.name === "partner_form");
    expect(form).toBeDefined();
    expect(form?.fields.map((f) => f.field)).toEqual([
      "name",
      "email",
      "phone",
      "is_company",
      "credit_limit",
    ]);

    const list = assembled.contributions.views.find((v) => v.name === "partner_list");
    expect(list).toBeDefined();
    expect(list?.fields.map((f) => f.field)).toEqual(["name", "email"]);
  });
});
