/**
 * Opt-in evolution cadence wiring — unit tests.
 *
 * Covers `resolveCadenceIntervalMs` (env → interval | OFF) and
 * `createEvolutionCadence` (null without a runtime; a tick that runs one cycle
 * and persists its proposals as DRAFTS only — never approving/graduating).
 */

import { describe, expect, test } from "bun:test";
import {
  createProposalEngine,
  type EvolutionRuntime,
  type ProposalDefinition,
} from "@linchkit/core/server";
import {
  CADENCE_ENV_KEY,
  CADENCE_TENANTS_ENV_KEY,
  createEvolutionCadence,
  resolveCadenceIntervalMs,
  resolveCadenceTenantIds,
} from "../src/evolution-scheduler-wiring";

const SILENT = { debug() {}, info() {}, warn() {}, error() {} } as const;

function cycleProposal(): ProposalDefinition {
  const now = new Date();
  return {
    id: "cycle-src-1",
    title: "Add late_fee rule",
    description: "Adds a late-fee rule",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability: "cap-demo",
    changeType: "minor",
    changes: [{ target: "rule", operation: "create", name: "late_fee" }],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: ["late_fee"],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  } as ProposalDefinition;
}

describe("resolveCadenceIntervalMs", () => {
  test("OFF (null) unless a positive integer is set", () => {
    expect(resolveCadenceIntervalMs({})).toBeNull();
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "" })).toBeNull();
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "   " })).toBeNull();
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "abc" })).toBeNull();
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "0" })).toBeNull();
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "-5" })).toBeNull();
    // A sub-1ms fraction floors to 0 → OFF (must not enable at the 1s floor).
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "0.5" })).toBeNull();
  });

  test("parses a positive integer (floors floats)", () => {
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "60000" })).toBe(60_000);
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "1500.9" })).toBe(1500);
  });
});

describe("resolveCadenceTenantIds", () => {
  test("empty unless set; parses comma-separated, trimmed, non-empty", () => {
    expect(resolveCadenceTenantIds({})).toEqual([]);
    expect(resolveCadenceTenantIds({ [CADENCE_TENANTS_ENV_KEY]: "   " })).toEqual([]);
    expect(resolveCadenceTenantIds({ [CADENCE_TENANTS_ENV_KEY]: "t1, t2 ,, t3," })).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });
});

describe("createEvolutionCadence", () => {
  test("returns null when no evolution runtime / cycle is wired", () => {
    expect(createEvolutionCadence({ intervalMs: 1000, logger: SILENT })).toBeNull();
    expect(
      createEvolutionCadence({
        intervalMs: 1000,
        evolutionRuntime: {} as EvolutionRuntime,
        logger: SILENT,
      }),
    ).toBeNull();
  });

  test("tick runs the cycle and persists its proposals as DRAFTS (never approves)", async () => {
    let cycleRuns = 0;
    const fakeRuntime = {
      evolutionCycle: {
        runCycle: async () => {
          cycleRuns += 1;
          return { proposals: [cycleProposal()] };
        },
      },
    } as unknown as EvolutionRuntime;
    const engine = createProposalEngine();

    const scheduler = createEvolutionCadence({
      evolutionRuntime: fakeRuntime,
      intervalMs: 1000,
      engine,
      logger: SILENT,
    });
    expect(scheduler).not.toBeNull();
    expect(scheduler?.isRunning()).toBe(false); // inert until start()

    const ran = await scheduler?.runOnce();
    expect(ran).toBe(true);
    expect(cycleRuns).toBe(1);

    const drafts = engine.listProposals({ status: "draft" });
    expect(drafts.length).toBe(1);
    expect(drafts[0]?.status).toBe("draft");
    // No proposal ever reached an approved/committed state via the cadence tick.
    expect(engine.listProposals({ status: "approved" }).length).toBe(0);
  });

  test("with tenantIds, runs one SCOPED cycle per tenant (no cross-tenant sensing)", async () => {
    const seenTenants: Array<string | undefined> = [];
    const fakeRuntime = {
      evolutionCycle: {
        runCycle: async (ctx?: { tenantId?: string }) => {
          seenTenants.push(ctx?.tenantId);
          return { proposals: [] };
        },
      },
    } as unknown as EvolutionRuntime;
    const scheduler = createEvolutionCadence({
      evolutionRuntime: fakeRuntime,
      intervalMs: 1000,
      tenantIds: ["tenant-a", "tenant-b"],
      engine: createProposalEngine(),
      logger: SILENT,
    });
    await scheduler?.runOnce();
    expect(seenTenants).toEqual(["tenant-a", "tenant-b"]);
  });

  test("without tenantIds, runs a single default-scope (tenant-less) cycle", async () => {
    const seenTenants: Array<string | undefined> = [];
    const fakeRuntime = {
      evolutionCycle: {
        runCycle: async (ctx?: { tenantId?: string }) => {
          seenTenants.push(ctx?.tenantId);
          return { proposals: [] };
        },
      },
    } as unknown as EvolutionRuntime;
    const scheduler = createEvolutionCadence({
      evolutionRuntime: fakeRuntime,
      intervalMs: 1000,
      engine: createProposalEngine(),
      logger: SILENT,
    });
    await scheduler?.runOnce();
    expect(seenTenants).toEqual([undefined]);
  });

  test("one tenant's failing cycle does not starve later tenants", async () => {
    const seenTenants: Array<string | undefined> = [];
    const fakeRuntime = {
      evolutionCycle: {
        runCycle: async (ctx?: { tenantId?: string }) => {
          seenTenants.push(ctx?.tenantId);
          if (ctx?.tenantId === "tenant-a") throw new Error("sensor exploded for tenant-a");
          return { proposals: [] };
        },
      },
    } as unknown as EvolutionRuntime;
    const scheduler = createEvolutionCadence({
      evolutionRuntime: fakeRuntime,
      intervalMs: 1000,
      tenantIds: ["tenant-a", "tenant-b"],
      engine: createProposalEngine(),
      logger: SILENT,
    });
    const ran = await scheduler?.runOnce();
    expect(ran).toBe(true); // the tick completed despite tenant-a failing
    // tenant-b still ran after tenant-a threw.
    expect(seenTenants).toEqual(["tenant-a", "tenant-b"]);
  });

  test("repeated cadence failures surface in liveness status; a clean tick clears the streak", async () => {
    // Regression: the per-tenant catch must not SWALLOW failures so completely
    // that the scheduler reports healthy. After attempting every scope, a tick
    // with any failure re-throws an aggregate, so getStatus() (→ GET
    // /api/evolution/scheduler-status) reflects a cadence stuck on errors.
    let failing = true;
    const fakeRuntime = {
      evolutionCycle: {
        runCycle: async () => {
          if (failing) throw new Error("sensor exploded");
          return { proposals: [] };
        },
      },
    } as unknown as EvolutionRuntime;
    const scheduler = createEvolutionCadence({
      evolutionRuntime: fakeRuntime,
      intervalMs: 1000,
      engine: createProposalEngine(),
      logger: SILENT,
    });

    await scheduler?.runOnce();
    await scheduler?.runOnce();
    expect(scheduler?.getStatus().consecutiveErrors).toBe(2);
    expect(scheduler?.getStatus().lastError).toContain("sensor exploded");

    // A subsequent all-green tick clears the streak — the loop recovered.
    failing = false;
    await scheduler?.runOnce();
    expect(scheduler?.getStatus().consecutiveErrors).toBe(0);
    expect(scheduler?.getStatus().lastError).toBeNull();
  });

  test("re-running the cadence tick is idempotent (deduped, not duplicated)", async () => {
    const fakeRuntime = {
      evolutionCycle: { runCycle: async () => ({ proposals: [cycleProposal()] }) },
    } as unknown as EvolutionRuntime;
    const engine = createProposalEngine();
    const scheduler = createEvolutionCadence({
      evolutionRuntime: fakeRuntime,
      intervalMs: 1000,
      engine,
      logger: SILENT,
    });
    await scheduler?.runOnce();
    await scheduler?.runOnce();
    // Same proposal twice → persisted once (dedup by capability + change set).
    expect(engine.listProposals({ status: "draft" }).length).toBe(1);
  });
});
