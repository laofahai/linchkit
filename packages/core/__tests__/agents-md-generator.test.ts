/**
 * Tests for AGENTS.md generator
 */

import { describe, expect, it } from "bun:test";
import { type AgentsMdOptions, generateAgentsMd } from "../src/ontology/agents-md-generator";

function makeOptions(overrides: Partial<AgentsMdOptions> = {}): AgentsMdOptions {
  return {
    projectName: "test-project",
    config: {},
    capabilities: [],
    entities: [],
    actions: [],
    relations: [],
    rules: [],
    states: [],
    ...overrides,
  };
}

describe("generateAgentsMd", () => {
  it("produces valid markdown for an empty project", () => {
    const result = generateAgentsMd(makeOptions());

    expect(result).toContain("# test-project — Development Guide");
    expect(result).toContain("## Overview");
    expect(result).toContain("## Tech Stack");
    expect(result).toContain("## Dev Commands");
    expect(result).toContain("## Conventions");
    // No entity/action/relation sections for empty project
    expect(result).not.toContain("## Entities");
    expect(result).not.toContain("## Actions");
    expect(result).not.toContain("## Relations");
  });

  it("includes entity sections with fields", () => {
    const result = generateAgentsMd(
      makeOptions({
        entities: [
          {
            name: "purchase_request",
            label: "Purchase Request",
            description: "A request to purchase goods",
            fields: {
              title: { type: "text", label: "Title", required: true },
              amount: { type: "number", label: "Amount", required: false },
            },
          },
        ],
      }),
    );

    expect(result).toContain("## Entities");
    expect(result).toContain("`purchase_request`");
    expect(result).toContain("Purchase Request");
    expect(result).toContain("A request to purchase goods");
    expect(result).toContain("| `title` | text | Yes | Title |");
    expect(result).toContain("| `amount` | number | No | Amount |");
  });

  it("includes action list grouped by entity", () => {
    const result = generateAgentsMd(
      makeOptions({
        actions: [
          {
            name: "submit_request",
            entity: "purchase_request",
            label: "Submit Request",
            description: "Submit a new purchase request",
            input: { title: { type: "text", required: true } },
            policy: { mode: "sync", transaction: true },
          },
          {
            name: "approve_request",
            entity: "purchase_request",
            label: "Approve Request",
            policy: { mode: "sync", transaction: true },
          },
        ],
      }),
    );

    expect(result).toContain("## Actions");
    expect(result).toContain("### purchase_request");
    expect(result).toContain("`submit_request`");
    expect(result).toContain("Submit a new purchase request");
    expect(result).toContain("Input: `title`");
    expect(result).toContain("`approve_request`");
  });

  it("includes relation section", () => {
    const result = generateAgentsMd(
      makeOptions({
        relations: [
          {
            name: "request_department",
            from: "purchase_request",
            to: "department",
            cardinality: "many_to_one" as const,
            label: { from: "Department" },
          },
        ],
      }),
    );

    expect(result).toContain("## Relations");
    expect(result).toContain("`purchase_request` → `department` (many_to_one)");
    expect(result).toContain('"Department"');
  });

  it("includes state machine section", () => {
    const result = generateAgentsMd(
      makeOptions({
        states: [
          {
            name: "request_state",
            entity: "purchase_request",
            field: "status",
            initial: "draft",
            states: ["draft", "submitted", "approved", "rejected"],
            transitions: [
              { from: "draft", to: "submitted", action: "submit_request" },
              { from: "submitted", to: "approved", action: "approve_request" },
              { from: "submitted", to: "rejected", action: "reject_request" },
            ],
          },
        ],
      }),
    );

    expect(result).toContain("## State Machines");
    expect(result).toContain("purchase_request");
    expect(result).toContain("draft, submitted, approved, rejected");
    expect(result).toContain("`draft` → `submitted` via action `submit_request`");
  });

  it("includes rules section", () => {
    const result = generateAgentsMd(
      makeOptions({
        rules: [
          {
            name: "require_amount",
            label: "Require Amount",
            description: "Amount must be positive",
            trigger: { action: "submit_request" },
            conditions: [],
            effects: [],
          },
        ],
      }),
    );

    expect(result).toContain("## Rules");
    expect(result).toContain("`require_amount`");
    expect(result).toContain("Amount must be positive");
  });

  it("includes capabilities table", () => {
    const result = generateAgentsMd(
      makeOptions({
        capabilities: [
          {
            name: "cap-purchase",
            label: "Purchase Management",
            type: "standard",
            category: "business",
            version: "1.0.0",
            description: "Purchase order management",
          },
        ],
      }),
    );

    expect(result).toContain("## Capabilities");
    expect(result).toContain("cap-purchase");
    expect(result).toContain("standard");
    expect(result).toContain("Purchase order management");
  });

  it("uses the provided project name in the header", () => {
    const result = generateAgentsMd(makeOptions({ projectName: "my-erp-app" }));
    expect(result).toContain("# my-erp-app — Development Guide");
  });

  it("includes multiple entities with correct structure", () => {
    const result = generateAgentsMd(
      makeOptions({
        entities: [
          {
            name: "department",
            label: "Department",
            fields: {
              name: { type: "text", required: true },
            },
          },
          {
            name: "employee",
            label: "Employee",
            fields: {
              full_name: { type: "text", required: true },
              email: { type: "email", required: true },
            },
          },
        ],
      }),
    );

    expect(result).toContain("`department`");
    expect(result).toContain("`employee`");
    expect(result).toContain("| `name` | text | Yes |");
    expect(result).toContain("| `full_name` | text | Yes |");
    expect(result).toContain("| `email` | email | Yes |");
  });

  it("omits empty optional sections", () => {
    const result = generateAgentsMd(
      makeOptions({
        entities: [
          {
            name: "item",
            label: "Item",
            fields: { name: { type: "text", required: true } },
          },
        ],
        // No actions, relations, states, rules
      }),
    );

    expect(result).toContain("## Entities");
    expect(result).not.toContain("## Actions");
    expect(result).not.toContain("## Relations");
    expect(result).not.toContain("## State Machines");
    expect(result).not.toContain("## Rules");
  });
});
