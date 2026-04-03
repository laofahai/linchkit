/**
 * E2E Test: Rule evaluation
 *
 * Validates that rules are evaluated correctly when actions are executed:
 * - Block rules prevent action execution
 * - Warn rules allow but return warnings
 * - Rules fire based on conditions (amount thresholds, etc.)
 *
 * Uses InMemoryStore with rule definitions and custom action handlers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ActionDefinition, RuleDefinition, SchemaDefinition } from "@linchkit/core";
import { createActionExecutor, evaluateRules, InMemoryStore } from "@linchkit/core/server";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Schema ────────────────────────────────────────────────

const purchaseSchema: SchemaDefinition = {
  name: "purchase",
  label: "Purchase",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount" },
    department: { type: "string", label: "Department" },
    status: { type: "string", default: "draft" },
  },
};

// ── Rule definitions ────────────────────────────────────────

const blockHighAmountRule: RuleDefinition = {
  name: "block_high_amount",
  label: "Block High Amount Purchases",
  description: "Block purchases over 100,000 without manager approval",
  trigger: { action: "submit_purchase" },
  condition: { field: "target.amount", operator: "gt", value: 100000 },
  effect: { type: "block", message: "Purchases over 100,000 require manager approval." },
};

const warnMediumAmountRule: RuleDefinition = {
  name: "warn_medium_amount",
  label: "Warn Medium Amount Purchases",
  description: "Warn on purchases between 10,000 and 100,000",
  trigger: { action: "submit_purchase" },
  condition: {
    operator: "and",
    conditions: [
      { field: "target.amount", operator: "gte", value: 10000 },
      { field: "target.amount", operator: "lte", value: 100000 },
    ],
  },
  effect: { type: "warn", message: "This purchase requires additional review." },
};

const blockEmptyTitleRule: RuleDefinition = {
  name: "block_empty_department",
  label: "Block Empty Department",
  description: "Block purchases with no department set",
  trigger: { action: "submit_purchase" },
  condition: { field: "target.department", operator: "is_null" },
  effect: { type: "block", message: "Department is required for submission." },
};

const rules: RuleDefinition[] = [blockHighAmountRule, warnMediumAmountRule, blockEmptyTitleRule];

// ── Custom actions with rule evaluation ─────────────────

const submitPurchaseAction: ActionDefinition = {
  name: "submit_purchase",
  schema: "purchase",
  label: "Submit Purchase",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase", id);

    // Evaluate rules against the record
    const evalOutput = await evaluateRules(rules, {
      target: record,
      actor: { type: "human", id: "user-1", groups: ["employee"] },
      context: {},
    });

    // Check for block rules
    if (evalOutput.blocked) {
      throw new Error(evalOutput.blockReasons[0]);
    }

    // Collect warnings
    const warnings = evalOutput.warnings.map((w) => w.message);

    const updated = await ctx.update("purchase", id, { status: "submitted" });
    return { ...updated, warnings };
  },
};

// ── Setup ────────────────────────────────────────────────

const PORT = 32130;
const REST_URL = `http://localhost:${PORT}/api/actions`;
const GQL_URL = `http://localhost:${PORT}/graphql`;

let store: InMemoryStore;
let app: ReturnType<typeof createServer>;

beforeAll(() => {
  store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });

  const allActions = [...generateCrudActions(purchaseSchema), submitPurchaseAction];
  for (const action of allActions) {
    executor.registry.register(action);
  }

  const graphqlSchema = buildGraphQLSchema([purchaseSchema], {
    executor,
    dataProvider: store,
    actions: [submitPurchaseAction],
  });

  app = createServer(graphqlSchema, { executor, rules });
  app.listen(PORT);
});

afterAll(() => {
  app.stop();
});

beforeEach(() => {
  store.clear();
});

// ── Helpers ────────────────────────────────────────────────

async function restAction(name: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${REST_URL}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function gql(query: string) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("E2E rule evaluation", () => {
  test("1. Block rule: high amount purchase is blocked", async () => {
    // Create a high-amount purchase
    const createResult = await restAction("create_purchase", {
      title: "Expensive Equipment",
      amount: 150000,
      department: "Engineering",
    });
    expect(createResult.status).toBe(200);
    const id = (createResult.body.data as Record<string, unknown>).id as string;

    // Try to submit — should be blocked by rule
    const submitResult = await restAction("submit_purchase", { id });
    expect(submitResult.status).toBe(422);
    expect(submitResult.body.success).toBe(false);
    const err = submitResult.body.error as Record<string, unknown>;
    expect(err.message as string).toContain("100,000");
    expect(err.message as string).toContain("manager approval");
  });

  test("2. Warn rule: medium amount purchase succeeds with warning", async () => {
    // Create a medium-amount purchase
    const createResult = await restAction("create_purchase", {
      title: "Office Furniture",
      amount: 25000,
      department: "Facilities",
    });
    const id = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — should succeed but with warning
    const submitResult = await restAction("submit_purchase", { id });
    expect(submitResult.status).toBe(200);
    expect(submitResult.body.success).toBe(true);

    const data = submitResult.body.data as Record<string, unknown>;
    expect(data.status).toBe("submitted");
    expect(data.warnings).toBeDefined();
    const warnings = data.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("additional review");
  });

  test("3. Block rule: missing department blocks submission", async () => {
    // Create without department
    const createResult = await restAction("create_purchase", {
      title: "Unassigned Purchase",
      amount: 500,
    });
    const id = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — should be blocked (no department)
    const submitResult = await restAction("submit_purchase", { id });
    expect(submitResult.status).toBe(422);
    expect(submitResult.body.success).toBe(false);
    const err = submitResult.body.error as Record<string, unknown>;
    expect(err.message as string).toContain("Department is required");
  });

  test("4. No rules triggered: low amount with department succeeds cleanly", async () => {
    // Create a low-amount purchase with department
    const createResult = await restAction("create_purchase", {
      title: "Office Supplies",
      amount: 500,
      department: "Admin",
    });
    const id = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — should succeed with no warnings
    const submitResult = await restAction("submit_purchase", { id });
    expect(submitResult.status).toBe(200);
    expect(submitResult.body.success).toBe(true);

    const data = submitResult.body.data as Record<string, unknown>;
    expect(data.status).toBe("submitted");
    const warnings = data.warnings as string[];
    expect(warnings.length).toBe(0);
  });

  test("5. Rules API endpoint returns rule definitions", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/rules`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data.length).toBe(3);

    const ruleNames = data.map((r) => r.name);
    expect(ruleNames).toContain("block_high_amount");
    expect(ruleNames).toContain("warn_medium_amount");
    expect(ruleNames).toContain("block_empty_department");
  });

  test("6. Record state unchanged after blocked rule", async () => {
    // Create a high-amount purchase with explicit status
    const createResult = await restAction("create_purchase", {
      title: "Blocked Purchase",
      amount: 200000,
      department: "Sales",
      status: "draft",
    });
    const id = (createResult.body.data as Record<string, unknown>).id as string;

    // Attempt submit (blocked)
    await restAction("submit_purchase", { id });

    // Verify status is still draft
    const getResult = await gql(`
      query { purchase(id: "${id}") { id status } }
    `);
    expect(getResult.errors).toBeUndefined();
    const purchase = getResult.data.purchase as Record<string, unknown>;
    expect(purchase.status).toBe("draft");
  });

  test("7. Boundary value: exactly 100,000 triggers warn but not block", async () => {
    const createResult = await restAction("create_purchase", {
      title: "Boundary Purchase",
      amount: 100000,
      department: "Engineering",
    });
    const id = (createResult.body.data as Record<string, unknown>).id as string;

    // Submit — should succeed (100,000 is not > 100,000 for block)
    // but should trigger warn (10,000 <= 100,000 <= 100,000)
    const submitResult = await restAction("submit_purchase", { id });
    expect(submitResult.status).toBe(200);
    expect(submitResult.body.success).toBe(true);

    const data = submitResult.body.data as Record<string, unknown>;
    expect(data.status).toBe("submitted");
    const warnings = data.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("8. Boundary value: exactly 100,001 triggers block", async () => {
    const createResult = await restAction("create_purchase", {
      title: "Just Over Limit",
      amount: 100001,
      department: "Engineering",
    });
    const id = (createResult.body.data as Record<string, unknown>).id as string;

    const submitResult = await restAction("submit_purchase", { id });
    expect(submitResult.status).toBe(422);
    expect(submitResult.body.success).toBe(false);
  });
});
