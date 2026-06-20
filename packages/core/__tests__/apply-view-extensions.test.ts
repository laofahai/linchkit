/**
 * Unit tests for `applyViewExtensions` — the boot-path view-inheritance merge.
 *
 * Pure function, no node_modules needed (bun:test built-in).
 */

import { describe, expect, it } from "bun:test";
import type { ViewDefinition } from "../src/types/view";
import { applyViewExtensions } from "../src/view/apply-view-extensions";

function baseForm(): ViewDefinition {
  return {
    name: "partner_form",
    entity: "partner",
    type: "form",
    fields: [{ field: "name" }, { field: "email" }],
    actions: [{ action: "archive_partner" }],
  };
}

function listView(): ViewDefinition {
  return {
    name: "partner_list",
    entity: "partner",
    type: "list",
    fields: [{ field: "name" }],
  };
}

describe("applyViewExtensions", () => {
  it("adds a new field by appending to fields[]", () => {
    const out = applyViewExtensions(
      [baseForm()],
      [{ target: "partner_form", extension: { addFields: [{ field: "credit_limit" }] } }],
    );
    const view = out.find((v) => v.name === "partner_form");
    expect(view?.fields.map((f) => f.field)).toEqual(["name", "email", "credit_limit"]);
  });

  it("removes a field", () => {
    const out = applyViewExtensions(
      [baseForm()],
      [{ target: "partner_form", extension: { removeFields: ["email"] } }],
    );
    const view = out.find((v) => v.name === "partner_form");
    expect(view?.fields.map((f) => f.field)).toEqual(["name"]);
  });

  it("overrides a field config via shallow merge", () => {
    const out = applyViewExtensions(
      [baseForm()],
      [
        {
          target: "partner_form",
          extension: { overrideFields: { email: { readonly: true, label: "E-mail" } } },
        },
      ],
    );
    const view = out.find((v) => v.name === "partner_form");
    const email = view?.fields.find((f) => f.field === "email");
    expect(email).toEqual({ field: "email", readonly: true, label: "E-mail" });
  });

  it("adds and removes actions", () => {
    const out = applyViewExtensions(
      [baseForm()],
      [
        {
          target: "partner_form",
          extension: {
            removeActions: ["archive_partner"],
            addActions: [{ action: "approve_partner" }],
          },
        },
      ],
    );
    const view = out.find((v) => v.name === "partner_form");
    expect(view?.actions?.map((a) => a.action)).toEqual(["approve_partner"]);
  });

  it("composes multiple extensions targeting the same view in array order", () => {
    const out = applyViewExtensions(
      [baseForm()],
      [
        { target: "partner_form", extension: { addFields: [{ field: "credit_limit" }] } },
        { target: "partner_form", extension: { addFields: [{ field: "tier" }] } },
        { target: "partner_form", extension: { removeFields: ["credit_limit"] } },
      ],
    );
    const view = out.find((v) => v.name === "partner_form");
    expect(view?.fields.map((f) => f.field)).toEqual(["name", "email", "tier"]);
  });

  it("leaves untargeted views untouched and routes patches to the right view", () => {
    const out = applyViewExtensions(
      [baseForm(), listView()],
      [{ target: "partner_list", extension: { addFields: [{ field: "email" }] } }],
    );
    expect(out.find((v) => v.name === "partner_form")?.fields.map((f) => f.field)).toEqual([
      "name",
      "email",
    ]);
    expect(out.find((v) => v.name === "partner_list")?.fields.map((f) => f.field)).toEqual([
      "name",
      "email",
    ]);
  });

  it("does not mutate the input views or their fields arrays (immutability)", () => {
    const input = baseForm();
    const inputFieldsRef = input.fields;
    const snapshot = JSON.stringify(input);
    const out = applyViewExtensions(
      [input],
      [{ target: "partner_form", extension: { addFields: [{ field: "credit_limit" }] } }],
    );
    // Input untouched.
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.fields).toBe(inputFieldsRef);
    expect(input.fields).toHaveLength(2);
    // Output is a different object with the change applied.
    expect(out[0]).not.toBe(input);
    expect(out[0]?.fields).not.toBe(inputFieldsRef);
    expect(out[0]?.fields).toHaveLength(3);
  });

  it("throws on an unknown target view", () => {
    expect(() =>
      applyViewExtensions(
        [baseForm()],
        [{ target: "nope", extension: { addFields: [{ field: "x" }] } }],
      ),
    ).toThrow('Cannot extend unknown view "nope"');
  });

  it("throws when addFields collides with an existing field", () => {
    expect(() =>
      applyViewExtensions(
        [baseForm()],
        [{ target: "partner_form", extension: { addFields: [{ field: "email" }] } }],
      ),
    ).toThrow('View "partner_form": field "email" already exists; use overrideFields');
  });

  it("throws when overrideFields targets a field not present (fail-loud, security)", () => {
    expect(() =>
      applyViewExtensions(
        [baseForm()],
        [{ target: "partner_form", extension: { overrideFields: { ghost: { readonly: true } } } }],
      ),
    ).toThrow('overrideFields targets unknown field "ghost"');
  });

  it("throws when overrideFields targets a field removed earlier in the same extension", () => {
    expect(() =>
      applyViewExtensions(
        [baseForm()],
        [
          {
            target: "partner_form",
            extension: { removeFields: ["email"], overrideFields: { email: { readonly: true } } },
          },
        ],
      ),
    ).toThrow('overrideFields targets unknown field "email"');
  });

  it("throws when addActions collides with an existing action", () => {
    expect(() =>
      applyViewExtensions(
        [baseForm()],
        [{ target: "partner_form", extension: { addActions: [{ action: "archive_partner" }] } }],
      ),
    ).toThrow('View "partner_form": action "archive_partner" already exists');
  });

  it("allows re-adding a field that the same extension removed first", () => {
    const out = applyViewExtensions(
      [baseForm()],
      [
        {
          target: "partner_form",
          extension: {
            removeFields: ["email"],
            addFields: [{ field: "email", readonly: true }],
          },
        },
      ],
    );
    const view = out.find((v) => v.name === "partner_form");
    const email = view?.fields.find((f) => f.field === "email");
    expect(email).toEqual({ field: "email", readonly: true });
  });

  // ── P2: fail-loud on the deferred layout case ──────────────────────────────

  it("throws on addFields against a view with an explicit layout.nodes", () => {
    const layoutForm: ViewDefinition = {
      name: "partner_form",
      entity: "partner",
      type: "form",
      fields: [{ field: "name" }],
      layout: { nodes: [{ type: "field", field: "name" }] },
    };
    expect(() =>
      applyViewExtensions(
        [layoutForm],
        [{ target: "partner_form", extension: { addFields: [{ field: "credit_limit" }] } }],
      ),
    ).toThrow(/has an explicit layout; addFields\/removeFields/);
  });

  it("treats a present-but-empty layout as layout-driven (fail-loud, not a silent no-op)", () => {
    const emptyLayoutForm: ViewDefinition = {
      name: "partner_form",
      entity: "partner",
      type: "form",
      fields: [{ field: "name" }],
      layout: { nodes: [] },
    };
    expect(() =>
      applyViewExtensions(
        [emptyLayoutForm],
        [{ target: "partner_form", extension: { addFields: [{ field: "credit_limit" }] } }],
      ),
    ).toThrow(/has an explicit layout/);
  });

  it("throws on removeFields against a view with legacy layout.sections", () => {
    const sectionForm: ViewDefinition = {
      name: "partner_form",
      entity: "partner",
      type: "form",
      fields: [{ field: "name" }, { field: "email" }],
      layout: { sections: [{ title: "Main", fields: ["name", "email"] }] },
    };
    expect(() =>
      applyViewExtensions(
        [sectionForm],
        [{ target: "partner_form", extension: { removeFields: ["email"] } }],
      ),
    ).toThrow(/has an explicit layout/);
  });

  it("still allows overrideFields on a layout view (no field-set mutation)", () => {
    const layoutForm: ViewDefinition = {
      name: "partner_form",
      entity: "partner",
      type: "form",
      fields: [{ field: "name" }],
      layout: { nodes: [{ type: "field", field: "name" }] },
    };
    const out = applyViewExtensions(
      [layoutForm],
      [{ target: "partner_form", extension: { overrideFields: { name: { readonly: true } } } }],
    );
    const name = out[0]?.fields.find((f) => f.field === "name");
    expect(name).toEqual({ field: "name", readonly: true });
  });
});
