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
  createEvolutionCadence,
  resolveCadenceIntervalMs,
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
  });

  test("parses a positive integer (floors floats)", () => {
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "60000" })).toBe(60_000);
    expect(resolveCadenceIntervalMs({ [CADENCE_ENV_KEY]: "1500.9" })).toBe(1500);
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
