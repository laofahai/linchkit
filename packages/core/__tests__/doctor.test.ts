/**
 * Tests for the Doctor registry and built-in checks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DoctorCheck, DoctorCheckResult, DoctorContext } from "../src/doctor/doctor-registry";
import { clearDoctorChecks, getDoctorChecks, registerDoctorCheck } from "../src/doctor/doctor-registry";
import {
  actionDefinitionsCheck,
  bunRuntimeCheck,
  builtinChecks,
  entityDefinitionsCheck,
  nodeEnvCheck,
} from "../src/doctor/builtin-checks";

// ── Registry tests ──────────────────────────────────────────────

describe("Doctor Registry", () => {
  beforeEach(() => {
    clearDoctorChecks();
  });

  afterEach(() => {
    clearDoctorChecks();
  });

  test("registerDoctorCheck adds to registry", () => {
    const check: DoctorCheck = {
      name: "test-check",
      description: "A test check",
      category: "runtime",
      async run(): Promise<DoctorCheckResult> {
        return { name: "test-check", status: "pass", message: "OK" };
      },
    };

    registerDoctorCheck(check);
    const checks = getDoctorChecks();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("test-check");
  });

  test("getDoctorChecks returns all registered checks", () => {
    const check1: DoctorCheck = {
      name: "check-1",
      description: "First",
      category: "runtime",
      async run(): Promise<DoctorCheckResult> {
        return { name: "check-1", status: "pass", message: "OK" };
      },
    };
    const check2: DoctorCheck = {
      name: "check-2",
      description: "Second",
      category: "database",
      async run(): Promise<DoctorCheckResult> {
        return { name: "check-2", status: "fail", message: "Bad" };
      },
    };

    registerDoctorCheck(check1);
    registerDoctorCheck(check2);

    const checks = getDoctorChecks();
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.name)).toEqual(["check-1", "check-2"]);
  });

  test("clearDoctorChecks resets the registry", () => {
    const check: DoctorCheck = {
      name: "ephemeral",
      description: "Will be cleared",
      category: "quality",
      async run(): Promise<DoctorCheckResult> {
        return { name: "ephemeral", status: "pass", message: "OK" };
      },
    };

    registerDoctorCheck(check);
    expect(getDoctorChecks()).toHaveLength(1);

    clearDoctorChecks();
    expect(getDoctorChecks()).toHaveLength(0);
  });

  test("getDoctorChecks returns a copy (mutations don't affect registry)", () => {
    const check: DoctorCheck = {
      name: "safe",
      description: "Safe check",
      category: "runtime",
      async run(): Promise<DoctorCheckResult> {
        return { name: "safe", status: "pass", message: "OK" };
      },
    };

    registerDoctorCheck(check);
    const checks = getDoctorChecks();
    checks.pop(); // Mutate the returned array

    // Registry should still have the check
    expect(getDoctorChecks()).toHaveLength(1);
  });
});

// ── Built-in checks tests ────────────────────────────────────────

describe("Built-in checks", () => {
  const baseCtx: DoctorContext = {
    projectRoot: process.cwd(),
    hasDatabase: false,
  };

  test("builtinChecks has expected count", () => {
    expect(builtinChecks.length).toBe(8);
  });

  test("all built-in checks have valid structure", () => {
    for (const check of builtinChecks) {
      expect(check.name).toBeTruthy();
      expect(check.description).toBeTruthy();
      expect(["runtime", "database", "definitions", "quality", "capability"]).toContain(
        check.category,
      );
      expect(typeof check.run).toBe("function");
    }
  });

  test("bun-runtime check returns pass result", async () => {
    const result = await bunRuntimeCheck.run(baseCtx);
    expect(result.name).toBe("bun-runtime");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("Bun");
  });

  test("node-env check returns proper result", async () => {
    const result = await nodeEnvCheck.run(baseCtx);
    expect(result.name).toBe("node-env");
    // Status depends on whether NODE_ENV is set in the test environment
    expect(["pass", "warn"]).toContain(result.status);
  });

  test("entity-definitions check with no config returns warn", async () => {
    const result = await entityDefinitionsCheck.run(baseCtx);
    expect(result.name).toBe("entity-definitions");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("No entity definitions");
  });

  test("entity-definitions check with entities returns pass", async () => {
    const ctx: DoctorContext = {
      ...baseCtx,
      config: {
        capabilities: [
          { entities: [{ name: "order" }, { name: "product" }] },
        ],
      },
    };
    const result = await entityDefinitionsCheck.run(ctx);
    expect(result.name).toBe("entity-definitions");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("2");
  });

  test("action-definitions check with no config returns warn", async () => {
    const result = await actionDefinitionsCheck.run(baseCtx);
    expect(result.name).toBe("action-definitions");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("No action definitions");
  });

  test("action-definitions check with actions returns pass", async () => {
    const ctx: DoctorContext = {
      ...baseCtx,
      config: {
        capabilities: [
          { actions: [{ name: "create_order" }] },
        ],
      },
    };
    const result = await actionDefinitionsCheck.run(ctx);
    expect(result.name).toBe("action-definitions");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("1");
  });

  test("database-connection check skips when no database", async () => {
    const result = await builtinChecks
      .find((c) => c.name === "database-connection")?.run(baseCtx);
    expect(result.status).toBe("skip");
    expect(result.message).toContain("InMemoryStore");
  });

  test("database-migrations check skips when no database", async () => {
    const result = await builtinChecks
      .find((c) => c.name === "database-migrations")?.run(baseCtx);
    expect(result.status).toBe("skip");
  });

  test("check results have proper structure", async () => {
    const result = await bunRuntimeCheck.run(baseCtx);
    expect(result).toHaveProperty("name");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("message");
    expect(typeof result.name).toBe("string");
    expect(typeof result.status).toBe("string");
    expect(typeof result.message).toBe("string");
  });
});

// ── Category filtering tests ─────────────────────────────────────

describe("Category filtering", () => {
  beforeEach(() => {
    clearDoctorChecks();
  });

  afterEach(() => {
    clearDoctorChecks();
  });

  test("checks can be filtered by category", () => {
    for (const check of builtinChecks) {
      registerDoctorCheck(check);
    }

    const all = getDoctorChecks();
    const runtimeChecks = all.filter((c) => c.category === "runtime");
    const dbChecks = all.filter((c) => c.category === "database");
    const defChecks = all.filter((c) => c.category === "definitions");
    const qualityChecks = all.filter((c) => c.category === "quality");

    expect(runtimeChecks.length).toBe(2);
    expect(dbChecks.length).toBe(2);
    expect(defChecks.length).toBe(2);
    expect(qualityChecks.length).toBe(2);
  });
});
