/**
 * Durable (`linch dev`) path guardrail for capability extension wiring.
 *
 * `collectCapabilityDefinitions` is the SINGLE upstream chokepoint: `dev.ts`
 * takes its `entities`/`views` and fans the SAME arrays out to `buildRegistries`
 * (EntityRegistry), `setupDatabase` (Drizzle schema / TableRegistry) and the
 * transport context. So the `cap.extensions.entities`/`.views` (`_inherit`)
 * merge MUST happen here — if it only happened inside `buildRegistries`, the
 * database/transport consumers would read unmerged definitions and a write or
 * query on the extension field would hit a column that does not exist.
 *
 * This proves the merged shape is what every durable-path consumer receives.
 */

import { describe, expect, it } from "bun:test";
import {
  type CapabilityDefinition,
  defineCapability,
  defineView,
  extendEntity,
  extendView,
} from "@linchkit/core";
import { collectCapabilityDefinitions } from "../src/commands/startup/collect-capabilities";

const capBase: CapabilityDefinition = defineCapability({
  name: "cap-base",
  label: "Base",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [
    {
      name: "partner",
      label: "Partner",
      fields: { name: { type: "string", required: true, label: "Name" } },
    },
  ],
  views: [
    defineView({
      name: "partner_form",
      entity: "partner",
      type: "form",
      // No explicit layout — renders from fields[].
      fields: [{ field: "name" }],
    }),
  ],
});

const capExt: CapabilityDefinition = defineCapability({
  name: "cap-ext",
  label: "Ext",
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

describe("collectCapabilityDefinitions — extension wiring (durable path chokepoint)", () => {
  it("folds the entity extension into `entities` (the array dev.ts feeds to setupDatabase + buildRegistries)", () => {
    const collected = collectCapabilityDefinitions([capBase, capExt]);
    const partner = collected.entities.find((e) => e.name === "partner");
    expect(partner).toBeDefined();
    expect(Object.keys(partner?.fields ?? {})).toContain("credit_limit");
    expect(partner?.fields.credit_limit?.type).toBe("number");
  });

  it("folds the view extension into `views`", () => {
    const collected = collectCapabilityDefinitions([capBase, capExt]);
    const form = collected.views.find((v) => v.name === "partner_form");
    expect(form?.fields.map((f) => f.field)).toEqual(["name", "credit_limit"]);
  });

  it("throws when an entity extension targets an unknown entity (fail-loud)", () => {
    const badExt: CapabilityDefinition = defineCapability({
      name: "cap-bad-ext",
      label: "Bad Ext",
      type: "bridge",
      category: "business",
      version: "0.1.0",
      extensions: {
        entities: [extendEntity("ghost", { fields: { x: { type: "string" } } })],
      },
    });
    expect(() => collectCapabilityDefinitions([capBase, badExt])).toThrow(
      'Cannot extend unknown entity "ghost"',
    );
  });

  it("throws when a view extension targets an unknown view (fail-loud)", () => {
    const badViewExt: CapabilityDefinition = defineCapability({
      name: "cap-bad-view-ext",
      label: "Bad View Ext",
      type: "bridge",
      category: "business",
      version: "0.1.0",
      extensions: {
        views: [extendView("ghost_form", { addFields: [{ field: "x" }] })],
      },
    });
    expect(() => collectCapabilityDefinitions([capBase, badViewExt])).toThrow(
      'Cannot extend unknown view "ghost_form"',
    );
  });
});
