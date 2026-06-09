/**
 * Proposal materialize → execution dry-run — REAL end-to-end smoke (Spec 70 P3).
 *
 * Proves the LIVE wiring: `runProposalMaterialization` with a real
 * `createSubprocessDryRunner` injected actually runs the freshly-materialized
 * candidate source in the hardened OS sandbox and stamps the durable
 * `dryRunStatus` the persisted draft carries (validation Phase 5 reads it).
 *
 * Gated on a USABLE host sandbox (macOS `sandbox-exec` / Linux `bwrap`), exactly
 * like cap-dry-run's own smokes — on a host without one the runner fails closed
 * (`infra_error`), which the fake-provider unit tests already cover. Dispatches
 * via the injectable orchestrator (no `app.listen`, no bound socket).
 */

import { describe, expect, test } from "bun:test";
import {
  createSubprocessDryRunner,
  detectSandboxStrategy,
  isSandboxStrategyUsable,
} from "@linchkit/cap-dry-run";
import type { ProposalChange, ProposalDefinition } from "@linchkit/core";
import type { CodeGenerationProvider, QualityGateRunner } from "@linchkit/core/server";
import {
  type MaterializeEngine,
  runProposalMaterialization,
} from "../src/proposal-materialize-api";

const DETECTED = detectSandboxStrategy();
const HAS_SANDBOX = DETECTED !== null && isSandboxStrategyUsable(DETECTED);
const itReal = HAS_SANDBOX ? test : test.skip;

/** A real, shimmed-core defineAction module (what the materializer would emit). */
function actionSource(name: string, body: string): string {
  return [
    'import { defineAction } from "@linchkit/core";',
    `export const generated = defineAction({ name: ${JSON.stringify(name)}, handler: async (ctx) => { ${body} } });`,
    "",
  ].join("\n");
}

function draft(changeName: string): ProposalDefinition {
  const now = new Date();
  return {
    id: "prop-dryrun-smoke",
    title: "dry-run smoke",
    description: "d",
    author: { type: "ai", id: "x", name: "X" },
    capability: "cap-demo",
    changeType: "minor",
    changes: [{ target: "action", operation: "create", name: changeName }],
    impact: {
      schemasAffected: [],
      actionsAffected: [changeName],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  } as ProposalDefinition;
}

function makeEngine(proposal: ProposalDefinition): MaterializeEngine {
  let current = proposal;
  return {
    getProposal(id) {
      if (current.id !== id) throw new Error("not found");
      return current;
    },
    updateProposal(_id, u) {
      current = { ...current, changes: u.changes ?? current.changes };
      return current;
    },
  };
}

/** A code-gen provider that returns the given source verbatim. */
function provider(source: string): CodeGenerationProvider {
  return {
    async generateCode() {
      return source;
    },
  };
}

const PASS_GATE: QualityGateRunner = { check: async () => [] };

describe(`materialize → real dry-run (${HAS_SANDBOX ? "active" : "SKIPPED: no host sandbox"})`, () => {
  itReal("a clean handler → dryRunStatus 'passed' stamped on the persisted draft", async () => {
    const engine = makeEngine(draft("deduct_inventory"));
    const outcome = await runProposalMaterialization("prop-dryrun-smoke", {
      engine,
      provider: provider(actionSource("deduct_inventory", "return { ok: true };")),
      qualityGate: PASS_GATE,
      dryRunProvider: createSubprocessDryRunner(),
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      const change = outcome.proposal.changes[0] as ProposalChange;
      expect(change.materializationStatus).toBe("materialized");
      expect(change.dryRunStatus).toBe("passed");
      expect(change.dryRunOutcomes?.[0]?.status).toBe("passed");
    }
  });

  itReal("a handler reaching for ctx I/O → dryRunStatus 'forbidden_side_effect'", async () => {
    const engine = makeEngine(draft("deduct_inventory"));
    const outcome = await runProposalMaterialization("prop-dryrun-smoke", {
      engine,
      provider: provider(
        actionSource("deduct_inventory", 'await ctx.create("order", {}); return { ok: true };'),
      ),
      qualityGate: PASS_GATE,
      dryRunProvider: createSubprocessDryRunner(),
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.proposal.changes[0]?.dryRunStatus).toBe("forbidden_side_effect");
    }
  });
});
