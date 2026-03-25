import { describe, expect, it } from "bun:test";
import { createFlowRegistry, FlowRegistryImpl } from "../src/flow/flow-registry";
import type { FlowDefinition } from "../src/types/flow";

// ── Test fixtures ───────────────────────────────────────

const simpleFlow: FlowDefinition = {
  name: "simple-flow",
  label: "Simple Flow",
  trigger: { type: "manual" },
  steps: [
    {
      id: "step1",
      name: "Step 1",
      type: "action",
      actionName: "purchase_request.submit",
      input: { amount: 100 },
    },
  ],
};

const eventTriggeredFlow: FlowDefinition = {
  name: "event-flow",
  label: "Event-triggered Flow",
  trigger: {
    type: "event",
    eventType: "action.succeeded",
    filter: { actionName: "purchase_request.submit" },
  },
  steps: [
    {
      id: "notify",
      name: "Notify Manager",
      type: "action",
      actionName: "notification.send",
    },
  ],
};

const anotherEventFlow: FlowDefinition = {
  name: "audit-flow",
  label: "Audit Flow",
  trigger: {
    type: "event",
    eventType: "action.succeeded",
  },
  steps: [
    {
      id: "audit",
      name: "Audit Log",
      type: "action",
      actionName: "audit.log",
    },
  ],
};

const conditionFlow: FlowDefinition = {
  name: "condition-flow",
  trigger: { type: "manual" },
  steps: [
    {
      id: "check",
      name: "Check Amount",
      type: "condition",
      expression: "$input.amount > 10000",
      then: "approve",
      else: "auto-approve",
    },
    {
      id: "approve",
      name: "Manager Approval",
      type: "action",
      actionName: "purchase_request.approve",
    },
    {
      id: "auto-approve",
      name: "Auto Approve",
      type: "action",
      actionName: "purchase_request.auto_approve",
    },
  ],
};

const scheduleFlow: FlowDefinition = {
  name: "schedule-flow",
  trigger: { type: "schedule", cron: "0 9 * * MON" },
  steps: [
    {
      id: "report",
      name: "Generate Report",
      type: "action",
      actionName: "report.generate",
    },
  ],
};

// ── Tests ───────────────────────────────────────────────

describe("FlowRegistry", () => {
  describe("createFlowRegistry()", () => {
    it("creates an empty registry", () => {
      const registry = createFlowRegistry();
      expect(registry.getAll()).toEqual([]);
    });

    it("returns a FlowRegistryImpl instance", () => {
      const registry = createFlowRegistry();
      expect(registry).toBeInstanceOf(FlowRegistryImpl);
    });
  });

  describe("register()", () => {
    it("registers a flow definition", () => {
      const registry = createFlowRegistry();
      registry.register(simpleFlow);
      expect(registry.has("simple-flow")).toBe(true);
      expect(registry.get("simple-flow")).toEqual(simpleFlow);
    });

    it("overwrites a previously registered flow with the same name", () => {
      const registry = createFlowRegistry();
      registry.register(simpleFlow);

      const updated = { ...simpleFlow, label: "Updated" };
      registry.register(updated);

      expect(registry.get("simple-flow")?.label).toBe("Updated");
      expect(registry.getAll()).toHaveLength(1);
    });

    it("throws when registering a flow with no name", () => {
      const registry = createFlowRegistry();
      expect(() =>
        registry.register({ ...simpleFlow, name: "" }),
      ).toThrow("non-empty name");
    });

    it("throws when registering a flow with no steps", () => {
      const registry = createFlowRegistry();
      expect(() =>
        registry.register({ ...simpleFlow, name: "empty", steps: [] }),
      ).toThrow("at least one step");
    });

    it("throws when registering a flow with duplicate step IDs", () => {
      const registry = createFlowRegistry();
      expect(() =>
        registry.register({
          name: "dup-steps",
          trigger: { type: "manual" },
          steps: [
            { id: "s1", name: "Step 1", type: "action", actionName: "a" },
            { id: "s1", name: "Step 2", type: "action", actionName: "b" },
          ],
        }),
      ).toThrow("duplicate step ID");
    });

    it("throws when a condition step references a non-existent then target", () => {
      const registry = createFlowRegistry();
      expect(() =>
        registry.register({
          name: "bad-cond",
          trigger: { type: "manual" },
          steps: [
            {
              id: "check",
              name: "Check",
              type: "condition",
              expression: "true",
              then: "nonexistent",
            },
          ],
        }),
      ).toThrow('references unknown step "nonexistent"');
    });

    it("throws when a parallel step references a non-existent sub-step", () => {
      const registry = createFlowRegistry();
      expect(() =>
        registry.register({
          name: "bad-parallel",
          trigger: { type: "manual" },
          steps: [
            {
              id: "par",
              name: "Parallel",
              type: "parallel",
              steps: ["nonexistent"],
            },
          ],
        }),
      ).toThrow('references unknown step "nonexistent"');
    });

    it("accepts a valid condition flow with cross-references", () => {
      const registry = createFlowRegistry();
      registry.register(conditionFlow);
      expect(registry.has("condition-flow")).toBe(true);
    });
  });

  describe("get()", () => {
    it("returns undefined for unregistered flow", () => {
      const registry = createFlowRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("getAll()", () => {
    it("returns all registered flows", () => {
      const registry = createFlowRegistry();
      registry.register(simpleFlow);
      registry.register(eventTriggeredFlow);
      registry.register(conditionFlow);

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      expect(all.map((f) => f.name).sort()).toEqual([
        "condition-flow",
        "event-flow",
        "simple-flow",
      ]);
    });
  });

  describe("has()", () => {
    it("returns false for unregistered flow", () => {
      const registry = createFlowRegistry();
      expect(registry.has("nope")).toBe(false);
    });

    it("returns true for registered flow", () => {
      const registry = createFlowRegistry();
      registry.register(simpleFlow);
      expect(registry.has("simple-flow")).toBe(true);
    });
  });

  describe("flowsForEvent()", () => {
    it("returns flows matching a specific event type", () => {
      const registry = createFlowRegistry();
      registry.register(simpleFlow); // manual trigger
      registry.register(eventTriggeredFlow); // event: action.succeeded
      registry.register(anotherEventFlow); // event: action.succeeded
      registry.register(scheduleFlow); // schedule trigger

      const matches = registry.flowsForEvent("action.succeeded");
      expect(matches).toHaveLength(2);
      expect(matches.map((f) => f.name).sort()).toEqual(["audit-flow", "event-flow"]);
    });

    it("returns empty array when no flows match the event type", () => {
      const registry = createFlowRegistry();
      registry.register(simpleFlow);

      expect(registry.flowsForEvent("unknown.event")).toEqual([]);
    });
  });

  describe("flowsForSchema()", () => {
    it("returns flows with action steps referencing a schema name", () => {
      const registry = createFlowRegistry();
      registry.register(simpleFlow); // action: purchase_request.submit
      registry.register(eventTriggeredFlow); // action: notification.send
      registry.register(conditionFlow); // actions: purchase_request.approve, purchase_request.auto_approve

      const matches = registry.flowsForSchema("purchase_request");
      expect(matches).toHaveLength(2);
      expect(matches.map((f) => f.name).sort()).toEqual(["condition-flow", "simple-flow"]);
    });

    it("returns empty array when no flows reference the schema", () => {
      const registry = createFlowRegistry();
      registry.register(simpleFlow);

      expect(registry.flowsForSchema("nonexistent_schema")).toEqual([]);
    });
  });
});
