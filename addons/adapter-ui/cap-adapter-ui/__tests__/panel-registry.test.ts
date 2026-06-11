/**
 * Panel-registry unit tests run against an ISOLATED instance from
 * createRecordPanelRegistry() — never against the shared module singleton.
 * Capability packages (cap-chatter-ui, …) register into the singleton at
 * import time and assert on it; clearing it here raced those assertions under
 * bun's batched test run (#539).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type React from "react";
import {
  createRecordPanelRegistry,
  type RecordPanelRegistration,
  type RecordPanelRegistry,
} from "../src/lib/panel-registry";

function makePanel(overrides: Partial<RecordPanelRegistration> = {}): RecordPanelRegistration {
  return {
    id: "test-panel",
    capability: "cap-test",
    slot: "record-detail-tab",
    label: "Test",
    component: () => Promise.resolve({ default: (() => null) as React.FC }),
    ...overrides,
  };
}

let registry: RecordPanelRegistry;

beforeEach(() => {
  registry = createRecordPanelRegistry();
});

describe("panel-registry", () => {
  test("registers and retrieves a panel", () => {
    registry.register(makePanel({ id: "chatter", capability: "cap-chatter", label: "Chatter" }));
    const panels = registry.getAll();
    expect(panels).toHaveLength(1);
    expect(panels[0]?.id).toBe("chatter");
  });

  test("sorts by order", () => {
    registry.register(makePanel({ id: "b", capability: "cap-b", label: "B", order: 200 }));
    registry.register(makePanel({ id: "a", capability: "cap-a", label: "A", order: 50 }));
    const panels = registry.getAll();
    expect(panels[0]?.id).toBe("a");
    expect(panels[1]?.id).toBe("b");
  });

  test("default order is 100", () => {
    registry.register(makePanel({ id: "no-order", capability: "cap-x", label: "X" }));
    registry.register(makePanel({ id: "high-order", capability: "cap-y", label: "Y", order: 200 }));
    const panels = registry.getAll();
    expect(panels[0]?.id).toBe("no-order");
    expect(panels[1]?.id).toBe("high-order");
  });

  test("rejects duplicate id", () => {
    registry.register(makePanel({ id: "dup", capability: "cap-x", label: "X" }));
    expect(() =>
      registry.register(makePanel({ id: "dup", capability: "cap-y", label: "Y" })),
    ).toThrow(/already registered/);
  });

  test("instances are isolated from each other and from the shared singleton", () => {
    registry.register(makePanel({ id: "iso" }));
    const other = createRecordPanelRegistry();
    expect(other.getAll()).toHaveLength(0);
  });
});
