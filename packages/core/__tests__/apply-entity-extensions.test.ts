/**
 * Unit tests for `applyEntityExtensions` — the contribution-stage
 * entity-inheritance (`_inherit`) field merge.
 *
 * Pure function, no node_modules needed (bun:test built-in).
 */

import { describe, expect, it } from "bun:test";
import { applyEntityExtensions } from "../src/entity/apply-entity-extensions";
import type { EntityDefinition } from "../src/types/entity";

function partner(): EntityDefinition {
  return {
    name: "partner",
    label: "Partner",
    fields: {
      name: { type: "string", required: true, label: "Name" },
      email: { type: "string", label: "Email" },
    },
  };
}

function company(): EntityDefinition {
  return {
    name: "company",
    label: "Company",
    fields: { legal_name: { type: "string", required: true } },
  };
}

describe("applyEntityExtensions", () => {
  it("adds a brand-new field to the target entity", () => {
    const out = applyEntityExtensions(
      [partner()],
      [
        {
          target: "partner",
          extension: { fields: { credit_limit: { type: "number", label: "Credit Limit" } } },
        },
      ],
    );
    const merged = out.find((e) => e.name === "partner");
    expect(Object.keys(merged?.fields ?? {})).toEqual(["name", "email", "credit_limit"]);
    expect(merged?.fields.credit_limit).toEqual({ type: "number", label: "Credit Limit" });
  });

  it("merges a colliding field via mergeFieldDefinition (constraint inheritance)", () => {
    // The extension restates `email` but omits the parent's constraints; the
    // merge keeps inheritable constraint keys from the parent unless restated.
    const base: EntityDefinition = {
      name: "partner",
      fields: {
        email: { type: "string", required: true, format: "email", label: "Email" },
      },
    };
    const out = applyEntityExtensions(
      [base],
      [
        {
          target: "partner",
          // child changes the label only; `required`/`format` are constraint
          // keys that should inherit from the parent.
          extension: { fields: { email: { type: "string", label: "E-mail Address" } } },
        },
      ],
    );
    const merged = out.find((e) => e.name === "partner");
    expect(merged?.fields.email).toEqual({
      type: "string",
      label: "E-mail Address",
      required: true,
      format: "email",
    });
  });

  it("composes multiple extensions targeting the same entity in array order", () => {
    const out = applyEntityExtensions(
      [partner()],
      [
        { target: "partner", extension: { fields: { credit_limit: { type: "number" } } } },
        { target: "partner", extension: { fields: { tier: { type: "string" } } } },
      ],
    );
    const merged = out.find((e) => e.name === "partner");
    expect(Object.keys(merged?.fields ?? {})).toEqual(["name", "email", "credit_limit", "tier"]);
  });

  it("routes extensions to the right entity and leaves others untouched", () => {
    const out = applyEntityExtensions(
      [partner(), company()],
      [{ target: "company", extension: { fields: { tax_id: { type: "string" } } } }],
    );
    expect(Object.keys(out.find((e) => e.name === "partner")?.fields ?? {})).toEqual([
      "name",
      "email",
    ]);
    expect(Object.keys(out.find((e) => e.name === "company")?.fields ?? {})).toEqual([
      "legal_name",
      "tax_id",
    ]);
  });

  it("does not mutate the input entities or their fields maps (immutability)", () => {
    const input = partner();
    const inputFieldsRef = input.fields;
    const snapshot = JSON.stringify(input);
    const out = applyEntityExtensions(
      [input],
      [{ target: "partner", extension: { fields: { credit_limit: { type: "number" } } } }],
    );
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.fields).toBe(inputFieldsRef);
    expect(Object.keys(input.fields)).toEqual(["name", "email"]);
    expect(out[0]).not.toBe(input);
    expect(out[0]?.fields).not.toBe(inputFieldsRef);
    expect(Object.keys(out[0]?.fields ?? {})).toEqual(["name", "email", "credit_limit"]);
  });

  it("throws on an unknown target entity", () => {
    expect(() =>
      applyEntityExtensions(
        [partner()],
        [{ target: "nope", extension: { fields: { x: { type: "string" } } } }],
      ),
    ).toThrow('Cannot extend unknown entity "nope"');
  });

  it("returns a new array even when there are no extensions", () => {
    const input = [partner()];
    const out = applyEntityExtensions(input, []);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });
});
