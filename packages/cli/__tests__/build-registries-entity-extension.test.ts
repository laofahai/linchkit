/**
 * Durable (`linch dev`) path guardrail for entity extension wiring.
 *
 * `buildRegistries` receives the pre-flattened `schemas` array and registers
 * each into the EntityRegistry. This test proves it now folds
 * `cap.extensions.entities` (the `_inherit` model) into those schemas BEFORE
 * registration, so `entityRegistry.resolve("partner")` carries the extension
 * field on the durable path too — not just the dev:server path.
 */

import { describe, expect, it } from "bun:test";
import {
  type CapabilityDefinition,
  ConfigRegistry,
  defineCapability,
  extendEntity,
} from "@linchkit/core";
import { buildRegistries } from "../src/commands/startup/build-registries";

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
  },
});

describe("buildRegistries — entity extension wiring (durable path)", () => {
  it("resolve('partner') includes the extension field", async () => {
    const capabilities = [capBase, capExt];
    // `schemas` are pre-flattened from cap.entities, exactly as dev.ts collects.
    const schemas = capabilities.flatMap((c) => c.entities ?? []);

    const { entityRegistry } = await buildRegistries({
      capabilities,
      interfaces: [],
      schemas,
      actions: [],
      links: [],
      middlewares: [],
      registry: ConfigRegistry.empty(),
      environment: { isDevelopment: true },
    });

    const resolved = entityRegistry.resolve("partner");
    expect(Object.keys(resolved.fields)).toContain("credit_limit");
    expect(resolved.fields.credit_limit?.definition.type).toBe("number");
  });

  it("throws when an extension targets an unknown entity (fail-loud)", async () => {
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
    const capabilities = [capBase, badExt];
    const schemas = capabilities.flatMap((c) => c.entities ?? []);

    await expect(
      buildRegistries({
        capabilities,
        interfaces: [],
        schemas,
        actions: [],
        links: [],
        middlewares: [],
        registry: ConfigRegistry.empty(),
        environment: { isDevelopment: true },
      }),
    ).rejects.toThrow('Cannot extend unknown entity "ghost"');
  });
});
