/**
 * Proposal materialize → execution dry-run WIRING — unit tests (Spec 70 P3 follow-up).
 *
 * Covers `runProposalMaterialization`'s injectable dry-run stage with a FAKE
 * `ExecutionDryRunProvider` (no subprocess): the durable `dryRunStatus` is stamped
 * + persisted, a failing/throwing runner stays advisory (never fails materialize),
 * the scope is honoured, and the runner is off by default. The real-sandbox path is
 * exercised by `proposal-materialize-dryrun-smoke.test.ts`. Shared fixtures live in
 * `materialize-fixtures.ts` (keeps each suite under the 500-line cap).
 */

import { describe, expect, test } from "bun:test";
import type { DryRunStatus, ExecutionDryRunProvider } from "@linchkit/core";
import { runProposalMaterialization } from "../src/proposal-materialize-api";
import { GOOD, makeEngine, makeProposal, makeProvider, PASS_GATE } from "./materialize-fixtures";

/** Fake execution dry-run runner returning a fixed status (or throwing). Spies jobs. */
function makeDryRunProvider(opts: { status?: DryRunStatus; throws?: boolean } = {}): {
  provider: ExecutionDryRunProvider;
  calls: { count: number; changeNames: string[] };
} {
  const calls = { count: 0, changeNames: [] as string[] };
  const provider: ExecutionDryRunProvider = {
    async dryRun(job) {
      calls.count += 1;
      calls.changeNames.push(job.changeName);
      if (opts.throws) throw new Error("sandbox unavailable");
      return {
        changeName: job.changeName,
        target: job.target,
        status: opts.status ?? "passed",
        inputCaseId: job.inputCaseId,
      };
    },
  };
  return { provider, calls };
}

describe("runProposalMaterialization — execution dry-run wiring (Spec 70 P3)", () => {
  test("stamps dryRunStatus on the materialized change and persists it", async () => {
    const { engine, updates } = makeEngine(makeProposal());
    const { provider } = makeProvider({ source: GOOD });
    const { provider: dryRunProvider, calls } = makeDryRunProvider({ status: "passed" });

    const outcome = await runProposalMaterialization("prop-abc12345", {
      engine,
      provider,
      qualityGate: PASS_GATE,
      dryRunProvider,
    });

    expect(outcome.kind).toBe("ok");
    expect(calls.count).toBe(1);
    expect(calls.changeNames).toEqual(["deduct_inventory"]);
    if (outcome.kind === "ok") {
      expect(outcome.proposal.changes[0]?.dryRunStatus).toBe("passed");
    }
    // The durable signal is part of the SAME persisted update as the source.
    expect(updates.at(-1)?.changes?.[0]?.dryRunStatus).toBe("passed");
    expect(updates.at(-1)?.changes?.[0]?.materializationStatus).toBe("materialized");
  });

  test("a forbidden_side_effect dry-run stamps that status (warn-only, still ok)", async () => {
    const { engine } = makeEngine(makeProposal());
    const { provider } = makeProvider({ source: GOOD });
    const { provider: dryRunProvider } = makeDryRunProvider({ status: "forbidden_side_effect" });

    const outcome = await runProposalMaterialization("prop-abc12345", {
      engine,
      provider,
      qualityGate: PASS_GATE,
      dryRunProvider,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.proposal.changes[0]?.dryRunStatus).toBe("forbidden_side_effect");
    }
  });

  test("a THROWING dry-run runner never fails materialization (advisory)", async () => {
    const { engine, updates } = makeEngine(makeProposal());
    const { provider } = makeProvider({ source: GOOD });
    const { provider: dryRunProvider } = makeDryRunProvider({ throws: true });

    const outcome = await runProposalMaterialization("prop-abc12345", {
      engine,
      provider,
      qualityGate: PASS_GATE,
      dryRunProvider,
    });

    // Materialization still succeeds; the per-case throw is contained as infra_error.
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.proposal.changes[0]?.materializationStatus).toBe("materialized");
      expect(outcome.proposal.changes[0]?.dryRunStatus).toBe("infra_error");
    }
    expect(updates.at(-1)?.changes?.[0]?.materializationStatus).toBe("materialized");
  });

  test("scoped retry dry-runs ONLY the scoped change; out-of-scope dryRunStatus preserved", async () => {
    // A 2-change draft: `untouched` was already materialized + dry-run "passed" in a
    // prior request; this request scopes a retry to `scoped`. The dry-run must follow
    // the materialization scope so it never overwrites `untouched`'s prior signal with
    // a fresh (here "threw") result — mirroring the scoped re-materialize contract.
    const proposal = makeProposal({
      changes: [
        { target: "action", operation: "create", name: "scoped" },
        {
          target: "action",
          operation: "create",
          name: "untouched",
          materializationStatus: "materialized",
          generatedSource: GOOD,
          dryRunStatus: "passed",
        },
      ],
    });
    const { engine } = makeEngine(proposal);
    const { provider } = makeProvider({ source: GOOD });
    const { provider: dryRunProvider, calls } = makeDryRunProvider({ status: "threw" });

    const outcome = await runProposalMaterialization("prop-abc12345", {
      engine,
      provider,
      qualityGate: PASS_GATE,
      dryRunProvider,
      changeNames: ["scoped"],
    });

    expect(outcome.kind).toBe("ok");
    expect(calls.changeNames).toEqual(["scoped"]);
    if (outcome.kind === "ok") {
      const scoped = outcome.proposal.changes.find((c) => c.name === "scoped");
      const untouched = outcome.proposal.changes.find((c) => c.name === "untouched");
      expect(scoped?.dryRunStatus).toBe("threw");
      // Preserved, NOT overwritten by the scoped retry's dry-run.
      expect(untouched?.dryRunStatus).toBe("passed");
    }
  });

  test("no dryRunProvider → no dry-run runs, dryRunStatus stays undefined (off by default)", async () => {
    const { engine } = makeEngine(makeProposal());
    const { provider } = makeProvider({ source: GOOD });

    const outcome = await runProposalMaterialization("prop-abc12345", {
      engine,
      provider,
      qualityGate: PASS_GATE,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.proposal.changes[0]?.materializationStatus).toBe("materialized");
      expect(outcome.proposal.changes[0]?.dryRunStatus).toBeUndefined();
    }
  });
});
