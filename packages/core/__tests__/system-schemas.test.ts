/**
 * Tests for system schemas — virtual read-only schemas for admin resources.
 */

import { describe, expect, it } from "bun:test";
import {
  executionLogSchema,
  executionLogListView,
  proposalSchema,
  proposalListView,
  approvalSchema,
  approvalListView,
  ruleSchema,
  ruleListView,
  flowSchema,
  flowListView,
  stateMachineSchema,
  stateMachineListView,
  SYSTEM_SCHEMAS,
  SYSTEM_VIEWS,
  isSystemSchema,
} from "../src/system-schemas";
import { SchemaRegistry } from "../src/schema/schema-registry";

describe("System Schemas", () => {
  describe("schema definitions", () => {
    it("should define 6 system schemas", () => {
      expect(SYSTEM_SCHEMAS).toHaveLength(6);
    });

    it("should define 6 system views", () => {
      expect(SYSTEM_VIEWS).toHaveLength(6);
    });

    it("all system schema names should start with _", () => {
      for (const schema of SYSTEM_SCHEMAS) {
        expect(schema.name.startsWith("_")).toBe(true);
      }
    });

    it("all system views should reference their schema", () => {
      for (const view of SYSTEM_VIEWS) {
        const schema = SYSTEM_SCHEMAS.find((s) => s.name === view.schema);
        expect(schema).toBeDefined();
      }
    });

    it("all system schemas have exposure disabled", () => {
      for (const schema of SYSTEM_SCHEMAS) {
        expect(schema.exposure?.graphql).toBe(false);
        expect(schema.exposure?.mcp).toBe(false);
      }
    });
  });

  describe("isSystemSchema", () => {
    it("should return true for underscore-prefixed names", () => {
      expect(isSystemSchema("_execution")).toBe(true);
      expect(isSystemSchema("_rule")).toBe(true);
      expect(isSystemSchema("_flow")).toBe(true);
    });

    it("should return false for regular schema names", () => {
      expect(isSystemSchema("purchase_request")).toBe(false);
      expect(isSystemSchema("task")).toBe(false);
    });
  });

  describe("execution log schema", () => {
    it("should have correct name and fields", () => {
      expect(executionLogSchema.name).toBe("_execution");
      expect(executionLogSchema.fields.action.type).toBe("string");
      expect(executionLogSchema.fields.status.type).toBe("enum");
      expect(executionLogSchema.fields.duration.type).toBe("number");
      expect(executionLogSchema.fields.started_at.type).toBe("datetime");
    });

    it("should have a list view with sortable/filterable fields", () => {
      expect(executionLogListView.type).toBe("list");
      expect(executionLogListView.schema).toBe("_execution");
      const statusField = executionLogListView.fields.find((f) => f.field === "status");
      expect(statusField?.filterable).toBe(true);
      expect(statusField?.sortable).toBe(true);
    });

    it("should have presentation metadata", () => {
      expect(executionLogSchema.presentation?.titleField).toBe("action");
      expect(executionLogSchema.presentation?.badgeField).toBe("status");
      expect(executionLogSchema.presentation?.icon).toBe("activity");
    });
  });

  describe("proposal schema", () => {
    it("should have correct name and fields", () => {
      expect(proposalSchema.name).toBe("_proposal");
      expect(proposalSchema.fields.title.type).toBe("string");
      expect(proposalSchema.fields.status.type).toBe("enum");
      expect(proposalSchema.fields.change_type.type).toBe("enum");
    });

    it("should have a list view", () => {
      expect(proposalListView.type).toBe("list");
      expect(proposalListView.schema).toBe("_proposal");
    });
  });

  describe("approval schema", () => {
    it("should have correct name and fields", () => {
      expect(approvalSchema.name).toBe("_approval");
      expect(approvalSchema.fields.action.type).toBe("string");
      expect(approvalSchema.fields.status.type).toBe("enum");
      expect(approvalSchema.fields.level.type).toBe("string");
    });

    it("should have a list view", () => {
      expect(approvalListView.type).toBe("list");
      expect(approvalListView.schema).toBe("_approval");
    });
  });

  describe("rule schema", () => {
    it("should have correct name and fields", () => {
      expect(ruleSchema.name).toBe("_rule");
      expect(ruleSchema.fields.name.type).toBe("string");
      expect(ruleSchema.fields.trigger_type.type).toBe("enum");
      expect(ruleSchema.fields.effect_type.type).toBe("enum");
    });

    it("should have a list view", () => {
      expect(ruleListView.type).toBe("list");
      expect(ruleListView.schema).toBe("_rule");
    });
  });

  describe("flow schema", () => {
    it("should have correct name and fields", () => {
      expect(flowSchema.name).toBe("_flow");
      expect(flowSchema.fields.name.type).toBe("string");
      expect(flowSchema.fields.trigger_type.type).toBe("enum");
      expect(flowSchema.fields.steps_count.type).toBe("number");
    });

    it("should have a list view", () => {
      expect(flowListView.type).toBe("list");
      expect(flowListView.schema).toBe("_flow");
    });
  });

  describe("state machine schema", () => {
    it("should have correct name and fields", () => {
      expect(stateMachineSchema.name).toBe("_state_machine");
      expect(stateMachineSchema.fields.name.type).toBe("string");
      expect(stateMachineSchema.fields.schema.type).toBe("string");
      expect(stateMachineSchema.fields.initial.type).toBe("string");
    });

    it("should have a list view", () => {
      expect(stateMachineListView.type).toBe("list");
      expect(stateMachineListView.schema).toBe("_state_machine");
    });
  });

  describe("SchemaRegistry integration", () => {
    it("should register all system schemas without error", () => {
      const registry = new SchemaRegistry();
      for (const schema of SYSTEM_SCHEMAS) {
        registry.register(schema);
      }
      expect(registry.has("_execution")).toBe(true);
      expect(registry.has("_proposal")).toBe(true);
      expect(registry.has("_approval")).toBe(true);
      expect(registry.has("_rule")).toBe(true);
      expect(registry.has("_flow")).toBe(true);
      expect(registry.has("_state_machine")).toBe(true);
    });

    it("should resolve system schemas with system fields injected", () => {
      const registry = new SchemaRegistry();
      for (const schema of SYSTEM_SCHEMAS) {
        registry.register(schema);
      }
      const resolved = registry.resolve("_execution");
      expect(resolved).toBeDefined();
      // System fields are injected
      expect(resolved!.fields.id).toBeDefined();
      expect(resolved!.fields.created_at).toBeDefined();
      // User-defined fields exist
      expect(resolved!.fields.action).toBeDefined();
      expect(resolved!.fields.status).toBeDefined();
    });

    it("should not conflict with regular schemas", () => {
      const registry = new SchemaRegistry();
      registry.register({
        name: "task",
        fields: { title: { type: "string", required: true } },
      });
      for (const schema of SYSTEM_SCHEMAS) {
        registry.register(schema);
      }
      expect(registry.has("task")).toBe(true);
      expect(registry.has("_execution")).toBe(true);
      expect(registry.getAll()).toHaveLength(7); // 1 user + 6 system
    });
  });
});
