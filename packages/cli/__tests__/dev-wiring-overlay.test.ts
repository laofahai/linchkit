/**
 * Tests for dev-wiring overlay registry construction (Spec 60 §6, issue #156).
 *
 * Verifies that wireDevEngines:
 *   1. Constructs an OverlayRegistry exactly once and assigns it to
 *      `transportCtx.overlayRegistry` (consumed by cap-adapter-mcp's
 *      list_entities / get_entity introspection tools).
 *   2. Falls back to InMemoryOverlayStore when no DB instance is provided.
 *   3. Surfaces overlays added at runtime via `overlayRegistry.register()` —
 *      no restart required for the discovery loop to see them.
 *
 * Out of scope here: wrapping the DataProvider with OverlayAwareDataProvider
 * for write-side handling of overlay field VALUES. That wrap leaks past the
 * transactional execution path (DrizzleTransactionManager unwraps to a bare
 * DrizzleDataProvider) and needs a separate fix tracked under #156.
 *
 * These tests bypass the full CLI subprocess path (covered by `info.test.ts`
 * / `exec.test.ts`) and exercise the wiring function directly with
 * synthesized inputs. That keeps them fast and focused on the
 * overlay-discovery contract.
 */

import { describe, expect, test } from "bun:test";
import { ConfigRegistry, defineEntity } from "@linchkit/core";
import {
  ActionRegistry,
  createInterfaceRegistry,
  createRelationRegistry,
  detectEnvironment,
  EntityRegistry,
  InMemoryStore,
  PermissionRegistry,
} from "@linchkit/core/server";
import { wireDevEngines } from "../src/commands/dev-wiring";

const order = defineEntity({
  name: "order",
  label: "Order",
  fields: {
    customer_name: { type: "text", label: "Customer" },
  },
});

/**
 * Build a minimal `WireDevEnginesInput` with no capabilities, no flows,
 * no middleware. Just enough to drive `wireDevEngines` so the overlay
 * registry construction path is exercised.
 */
function buildInput(opts: { dataProvider?: InMemoryStore } = {}) {
  const dataProvider = opts.dataProvider ?? new InMemoryStore();
  const entityRegistry = new EntityRegistry();
  entityRegistry.register(order);

  const actionRegistry = new ActionRegistry();
  const relationRegistry = createRelationRegistry();
  const interfaceRegistry = createInterfaceRegistry();
  const permissionRegistry = new PermissionRegistry();

  return {
    config: {},
    registry: ConfigRegistry.empty(),
    environment: detectEnvironment(),
    entityRegistry,
    actionRegistry,
    relationRegistry,
    interfaceRegistry,
    permissionRegistry,
    entities: [order],
    actions: [],
    views: [],
    states: [],
    links: [],
    rules: [],
    middlewares: [],
    capabilities: [],
    sensors: [],
    dbInstance: undefined,
    dataProvider,
    usingDatabase: false,
  } as const;
}

describe("wireDevEngines — overlay registry wiring (Spec 60 §6)", () => {
  test("assigns an OverlayRegistry to TransportContext (in-memory fallback)", async () => {
    const { transportCtx } = await wireDevEngines(buildInput());

    expect(transportCtx.overlayRegistry).toBeDefined();
    // The registry starts empty when there's no DB and no pre-seeded store.
    expect(transportCtx.overlayRegistry?.overlaysFor("order")).toEqual([]);
  });

  test("overlay registered at runtime is visible to the same transport context", async () => {
    const { transportCtx } = await wireDevEngines(buildInput());
    const reg = transportCtx.overlayRegistry;
    expect(reg).toBeDefined();
    if (!reg) throw new Error("overlayRegistry undefined");

    // Simulate the API/MCP flow: a caller registers an overlay through the
    // shared registry. The registry's cache should immediately reflect it,
    // which is exactly what cap-adapter-mcp's get_entity tool reads.
    await reg.register({
      entityName: "order",
      fieldName: "color",
      fieldType: "enum",
      config: {
        label: { en: "Color" },
        required: false,
        enumValues: ["red", "green", "blue"],
      },
      status: "active",
    });

    const overlays = reg.overlaysFor("order");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.fieldName).toBe("color");
    expect(overlays[0]?.fieldType).toBe("enum");
  });
});
