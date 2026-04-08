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
        // No actions, relations, states, rules, views
      }),
    );

    expect(result).toContain("## Entities");
    expect(result).not.toContain("## Actions");
    expect(result).not.toContain("## Relations");
    expect(result).not.toContain("## State Machines");
    expect(result).not.toContain("## Rules");
    expect(result).not.toContain("## Views");
  });

  it("includes views table when views exist", () => {
    const result = generateAgentsMd(
      makeOptions({
        views: [
          {
            name: "request_list",
            entity: "purchase_request",
            type: "list",
            fields: [],
          },
          {
            name: "request_form",
            entity: "purchase_request",
            type: "form",
            fields: [],
          },
        ],
      }),
    );

    expect(result).toContain("## Views");
    expect(result).toContain("| request_list | purchase_request | list |");
    expect(result).toContain("| request_form | purchase_request | form |");
  });

  it("omits views section when no views exist", () => {
    const result = generateAgentsMd(makeOptions({ views: [] }));
    expect(result).not.toContain("## Views");
  });

  it("includes anti-patterns section", () => {
    const result = generateAgentsMd(makeOptions());

    expect(result).toContain("## Anti-Patterns");
    expect(result).toContain("Do NOT** write to the database directly");
    expect(result).toContain("Do NOT** skip CommandLayer");
    expect(result).toContain("Do NOT** use `npm`, `npx`, or `node`");
    expect(result).toContain("Do NOT** hand-write `CREATE TABLE`");
  });

  it("includes semantic names (fromName/toName) in relations", () => {
    const result = generateAgentsMd(
      makeOptions({
        relations: [
          {
            name: "request_department",
            from: "purchase_request",
            to: "department",
            cardinality: "many_to_one" as const,
            fromName: "department",
            toName: "purchase_requests",
            label: { from: "Department" },
          },
        ],
      }),
    );

    expect(result).toContain("[department ↔ purchase_requests]");
    expect(result).toContain("`purchase_request` → `department`");
  });

  it("includes relation naming convention", () => {
    const result = generateAgentsMd(makeOptions());
    expect(result).toContain("Relation naming:");
    expect(result).toContain("fromName");
    expect(result).toContain("toName");
  });
});
