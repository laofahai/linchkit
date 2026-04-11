/**
 * Tests for the `linch describe relations` subcommand:
 * buildRelationsOverview, printRelationsOverview, and JSON output mode.
 *
 * Relation helpers are imported from describe-formatters.ts (not replicated).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineRelation } from "@linchkit/core";
import {
  buildRelationsOverview,
  printRelationsOverview,
} from "../src/commands/describe-formatters";

// ── Fixtures ─────────────────────────────────────────────

const testRelation = defineRelation({
  name: "order_department",
  from: "order",
  to: "department",
  cardinality: "many_to_one",
  fromName: "department",
  toName: "orders",
});

const testRelation2 = defineRelation({
  name: "order_customer",
  from: "order",
  to: "customer",
  cardinality: "many_to_one",
  fromName: "customer",
  toName: "placed_orders",
});

const testRelation3 = defineRelation({
  name: "department_company",
  from: "department",
  to: "company",
  cardinality: "many_to_one",
  fromName: "company",
  toName: "departments",
});

// ── Console capture helper ───────────────────────────────

let logOutput: string[];
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  logOutput = [];
  console.log = mock((...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  });
  console.error = mock((...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

function getOutput(): string {
  return logOutput.join("\n");
}

// ── buildRelationsOverview ──────────────────────────────

describe("buildRelationsOverview", () => {
  test("returns correct total count", () => {
    const overview = buildRelationsOverview([testRelation, testRelation2, testRelation3]);
    expect(overview.total).toBe(3);
  });

  test("returns empty overview for no relations", () => {
    const overview = buildRelationsOverview([]);
    expect(overview.total).toBe(0);
    expect(overview.relations).toHaveLength(0);
    expect(Object.keys(overview.bySourceEntity)).toHaveLength(0);
  });

  test("maps relation fields correctly", () => {
    const overview = buildRelationsOverview([testRelation]);
    expect(overview.relations).toHaveLength(1);
    const r = overview.relations[0];
    expect(r.name).toBe("order_department");
    expect(r.from).toBe("order");
    expect(r.to).toBe("department");
    expect(r.cardinality).toBe("many_to_one");
    expect(r.fromName).toBe("department");
    expect(r.toName).toBe("orders");
  });

  test("groups relations by source entity", () => {
    const overview = buildRelationsOverview([testRelation, testRelation2, testRelation3]);
    expect(Object.keys(overview.bySourceEntity)).toHaveLength(2);
    // order has 2 relations, department has 1
    expect(overview.bySourceEntity.order).toHaveLength(2);
    expect(overview.bySourceEntity.department).toHaveLength(1);
  });

  test("single relation grouped under its source", () => {
    const overview = buildRelationsOverview([testRelation3]);
    expect(overview.bySourceEntity.department).toHaveLength(1);
    expect(overview.bySourceEntity.department[0].name).toBe("department_company");
  });
});

// ── printRelationsOverview ──────────────────────────────

describe("printRelationsOverview", () => {
  test("prints header and total count", () => {
    const overview = buildRelationsOverview([testRelation]);
    printRelationsOverview(overview);
    const out = getOutput();
    expect(out).toContain("Relation Graph Overview");
    expect(out).toContain("=======================");
    expect(out).toContain("Total relations: 1");
  });

  test("prints empty message when no relations", () => {
    const overview = buildRelationsOverview([]);
    printRelationsOverview(overview);
    const out = getOutput();
    expect(out).toContain("Total relations: 0");
    expect(out).toContain("(no relations defined)");
  });

  test("prints relations grouped by source entity", () => {
    const overview = buildRelationsOverview([testRelation, testRelation2, testRelation3]);
    printRelationsOverview(overview);
    const out = getOutput();
    // Source entities appear as section headers
    expect(out).toContain("  order:");
    expect(out).toContain("  department:");
  });

  test("prints relation details with cardinality and semantic names", () => {
    const overview = buildRelationsOverview([testRelation]);
    printRelationsOverview(overview);
    const out = getOutput();
    expect(out).toContain(
      "order_department: order -> department (many_to_one) [department / orders]",
    );
  });

  test("sorts source entities alphabetically", () => {
    const overview = buildRelationsOverview([testRelation, testRelation3]);
    printRelationsOverview(overview);
    const out = getOutput();
    const departmentIdx = out.indexOf("  department:");
    const orderIdx = out.indexOf("  order:");
    expect(departmentIdx).toBeLessThan(orderIdx);
  });

  test("shows multiple relations under same source entity", () => {
    const overview = buildRelationsOverview([testRelation, testRelation2]);
    printRelationsOverview(overview);
    const out = getOutput();
    expect(out).toContain("order_department: order -> department");
    expect(out).toContain("order_customer: order -> customer");
  });
});

// ── Relations JSON output ───────────────────────────────

describe("relations JSON output", () => {
  test("buildRelationsOverview returns serializable JSON structure", () => {
    const overview = buildRelationsOverview([testRelation, testRelation2]);
    const json = JSON.stringify(overview, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.total).toBe(2);
    expect(parsed.relations).toHaveLength(2);
    expect(parsed.bySourceEntity.order).toHaveLength(2);
  });

  test("JSON includes fromName and toName for each relation", () => {
    const overview = buildRelationsOverview([testRelation]);
    const json = JSON.stringify(overview, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.relations[0].fromName).toBe("department");
    expect(parsed.relations[0].toName).toBe("orders");
  });

  test("JSON handles empty relations", () => {
    const overview = buildRelationsOverview([]);
    const json = JSON.stringify(overview, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.total).toBe(0);
    expect(parsed.relations).toEqual([]);
    expect(parsed.bySourceEntity).toEqual({});
  });
});
