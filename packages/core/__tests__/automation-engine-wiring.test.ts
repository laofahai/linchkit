/**
 * Integration test: AutomationEngine wiring
 *
 * Verifies the wiring pattern used in dev.ts — collecting automations
 * from capabilities, building a registry, creating the engine with
 * an action executor adapter, and processing events end-to-end.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createAutomationEngine } from "../src/automation/automation-engine";
import { createAutomationRegistry } from "../src/automation/automation-registry";
import type { AutomationDefinition } from "../src/types/automation";
import type { CapabilityDefinition } from "../src/types/capability";
import type { EventRecord } from "../src/types/event";

// ── Minimal mock event bus ──────────────────────────────

function createMockEventBus() {
  const handlers = new Map<string, Array<(event: EventRecord) => Promise<void>>>();
  return {
    handlers,
    subscribe(eventType: string, handler: (event: EventRecord) => Promise<void>) {
      if (!handlers.has(eventType)) handlers.set(eventType, []);
      handlers.get(eventType)?.push(handler);
      return () => {
        const arr = handlers.get(eventType);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
    },
    async emit(eventType: string, event: EventRecord) {
      const arr = handlers.get(eventType);
      if (arr) {
        for (const h of arr) await h(event);
      }
    },
  };
}

function makeEvent(
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<EventRecord> = {},
): EventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    payload,
    timestamp: new Date(),
    actor: { type: "system", id: "test" },
    executionId: `exec-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  };
}

// ── Test fixtures: simulate capabilities with automations ──

const sampleAutomation: AutomationDefinition = {
  name: "auto_submitted_at",
  description: "Set submitted_at on state change to pending",
  trigger: { type: "stateChange", entity: "purchase_request", to: "pending" },
  actions: [
    {
      type: "execute_action",
      action: "builtin:set_field",
      input: { entity: "purchase_request", field: "submitted_at", value: "{{$now}}" },
    },
  ],
  enabled: true,
};

const sampleCapabilities: CapabilityDefinition[] = [
  {
    name: "cap-demo",
    label: "Demo",
    type: "standard",
    category: "business",
    version: "0.0.1",
    automations: [sampleAutomation],
  },
  {
    name: "cap-other",
    label: "Other",
    type: "standard",
    category: "business",
    version: "0.0.1",
    // No automations
  },
];

// ── Tests ─────────────────────────────────────────────────

describe("AutomationEngine wiring (integration)", () => {
  let engine: ReturnType<typeof createAutomationEngine>;

  afterEach(() => {
    engine?.stop();
  });

  it("collects automations from capabilities and starts engine", async () => {
    // Simulate the collection loop from dev.ts
    const automations: AutomationDefinition[] = [];
    for (const cap of sampleCapabilities) {
      if (cap.automations) automations.push(...cap.automations);
    }

    expect(automations).toHaveLength(1);
    expect(automations[0]?.name).toBe("auto_submitted_at");

    // Build registry
    const registry = createAutomationRegistry();
    for (const automation of automations) {
      registry.register(automation);
    }

    // Build engine with mock event bus and action executor adapter (same pattern as dev.ts)
    const executedActions: Array<{ name: string; input: Record<string, unknown> }> = [];
    const bus = createMockEventBus();

    engine = createAutomationEngine({
      registry,
      eventBus: bus,
      actionExecutor: {
        executeAction: async (actionName, input) => {
          executedActions.push({ name: actionName, input });
          return { success: true };
        },
      },
    });

    engine.start();

    // Simulate a state change event
    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { _state: "draft" },
          _new: { _state: "pending" },
        },
        { entity: "purchase_request" },
      ),
    );

    // Action should have been executed
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]?.name).toBe("builtin:set_field");
    expect(executedActions[0]?.input).toMatchObject({
      entity: "purchase_request",
      field: "submitted_at",
    });
  });

  it("engine stops cleanly and no longer processes events", async () => {
    const registry = createAutomationRegistry();
    registry.register(sampleAutomation);

    const executedActions: string[] = [];
    const bus = createMockEventBus();

    engine = createAutomationEngine({
      registry,
      eventBus: bus,
      actionExecutor: {
        executeAction: async (actionName) => {
          executedActions.push(actionName);
          return {};
        },
      },
    });

    engine.start();
    engine.stop();

    // Event after stop should not trigger
    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        { _old: { _state: "draft" }, _new: { _state: "pending" } },
        { entity: "purchase_request" },
      ),
    );

    expect(executedActions).toHaveLength(0);
  });

  it("handles capabilities with no automations gracefully", () => {
    const automations: AutomationDefinition[] = [];
    for (const cap of sampleCapabilities) {
      if (cap.automations) automations.push(...cap.automations);
    }

    // Only 1 capability has automations
    const registry = createAutomationRegistry();
    for (const automation of automations) {
      registry.register(automation);
    }

    expect(registry.getAll()).toHaveLength(1);
  });
});
