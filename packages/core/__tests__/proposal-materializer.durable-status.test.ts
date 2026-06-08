/**
 * Proposal materializer — DURABLE materialization quality signal (G5 Phase 4).
 *
 * The materializer's `outcomes` array is transient (only in the POST /materialize
 * response). These tests pin the ADDITIVE durable signal it now stamps onto each
 * MATERIALIZABLE change so a reviewer reading the PERSISTED proposal can tell a
 * never-materialized change (undefined) apart from one whose generated source
 * FAILED the build/syntax gate ("failed" + errors) or succeeded ("materialized").
 *
 * No real model is called — the `CodeGenerationProvider` is an injected fake; the
 * quality gate is either the real syntax gate or a fake returning fixed errors.
 */

import { describe, expect, test } from "bun:test";
import type { CodeGenerationProvider, QualityGateRunner } from "../src/ai/proposal-code-generator";
import { createSyntaxQualityGate } from "../src/engine/code-quality-gate";
import { materializeProposalChanges } from "../src/engine/proposal-materializer";
import type { ProposalChange, ProposalDefinition } from "../src/types/proposal";

const GOOD = "export const deduct_inventory = 1;";
const BROKEN = "export const x = (((;"; // never parses → fails the syntax gate

function makeProposal(changes: ProposalChange[]): ProposalDefinition {
  const now = new Date();
  return {
    id: "prop-durable-1",
    title: "Add deduct_inventory action",
    description: "When an order is approved, deduct inventory",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability: "cap-demo",
    changeType: "minor",
    changes,
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  } as ProposalDefinition;
}

/** Fake provider that always returns the given source. */
function makeProvider(source: string): CodeGenerationProvider {
  return {
    async generateCode(): Promise<string> {
      return source;
    },
  };
}

/** Fake quality gate that always reports the given errors (empty = pass). */
function makeGate(errors: string[]): QualityGateRunner {
  return { check: async () => errors };
}

describe("materializeProposalChanges — durable materialization status", () => {
  test("success → materializationStatus 'materialized', no errors, source set", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider: makeProvider(GOOD),
      qualityGate: createSyntaxQualityGate(),
    });

    const change = result.proposal.changes[0];
    expect(change?.materializationStatus).toBe("materialized");
    expect(change?.materializationErrors).toBeUndefined();
    expect(change?.generatedSource).toBe(GOOD);
    // Transient outcome shape is unchanged.
    expect(result.outcomes[0]?.status).toBe("materialized");
  });

  test("gate failure after retries → status 'failed', errors[], no source", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);
    // Fake gate returns a fixed error so we don't depend on Bun.Transpiler's
    // exact message — the provider source is also genuinely broken for realism.
    const result = await materializeProposalChanges({
      proposal: input,
      provider: makeProvider(BROKEN),
      qualityGate: makeGate(["syntax error: unexpected token"]),
      maxRetries: 2,
    });

    const change = result.proposal.changes[0];
    expect(change?.materializationStatus).toBe("failed");
    expect(Array.isArray(change?.materializationErrors)).toBe(true);
    expect((change?.materializationErrors ?? []).length).toBeGreaterThan(0);
    expect(change?.materializationErrors?.[0]).toContain("syntax error");
    expect(change?.generatedSource).toBeUndefined();
    // Transient outcome still reports the same failure (unchanged behavior).
    expect(result.outcomes[0]?.status).toBe("failed");
    expect(result.allMaterialized).toBe(false);
  });

  test("real syntax gate on broken source → 'failed' with non-empty errors", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider: makeProvider(BROKEN),
      qualityGate: createSyntaxQualityGate(),
      maxRetries: 2,
    });

    const change = result.proposal.changes[0];
    expect(change?.materializationStatus).toBe("failed");
    expect((change?.materializationErrors ?? []).length).toBeGreaterThan(0);
    expect(change?.generatedSource).toBeUndefined();
  });

  test("declarative (entity) change → skipped, both durable fields undefined", async () => {
    const input = makeProposal([{ target: "entity", operation: "create", name: "invoice" }]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider: makeProvider(GOOD),
      qualityGate: createSyntaxQualityGate(),
    });

    const change = result.proposal.changes[0];
    expect(result.outcomes[0]?.status).toBe("skipped");
    expect(change?.materializationStatus).toBeUndefined();
    expect(change?.materializationErrors).toBeUndefined();
  });

  test("non-materializable change with a STALE signal → skipped, all artifacts cleared", async () => {
    // A change that was materialized while it was an action (so it carries
    // generatedSource + a "materialized" status), then edited to a declarative
    // (non-materializable) target. Re-materialization must CLEAR the stale
    // source/status/errors even though the change is now skipped — the clear runs
    // BEFORE the materializable check, so a skipped change never retains stale
    // materialization artifacts. (Regression for the gemini review on #513.)
    const input = makeProposal([
      {
        target: "entity",
        operation: "create",
        name: "invoice",
        generatedSource: GOOD,
        materializationStatus: "materialized",
        materializationErrors: ["stale error"],
      },
    ]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider: makeProvider(GOOD),
      qualityGate: createSyntaxQualityGate(),
    });

    const change = result.proposal.changes[0];
    expect(result.outcomes[0]?.status).toBe("skipped");
    expect(change?.generatedSource).toBeUndefined();
    expect(change?.materializationStatus).toBeUndefined();
    expect(change?.materializationErrors).toBeUndefined();
  });

  test("input proposal is NOT mutated — durable signal lands only on the returned copy", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider: makeProvider(GOOD),
      qualityGate: createSyntaxQualityGate(),
    });

    // The returned copy carries the signal…
    expect(result.proposal.changes[0]?.materializationStatus).toBe("materialized");
    // …but the original input change was never touched.
    expect(input.changes[0]?.materializationStatus).toBeUndefined();
    expect(input.changes[0]?.materializationErrors).toBeUndefined();
    expect(input.changes[0]?.generatedSource).toBeUndefined();
  });

  test("re-materialization clears a stale failure signal on success", async () => {
    // A change carrying a STALE failed signal from a prior attempt.
    const input = makeProposal([
      {
        target: "action",
        operation: "create",
        name: "deduct_inventory",
        materializationStatus: "failed",
        materializationErrors: ["old error"],
      },
    ]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider: makeProvider(GOOD),
      qualityGate: createSyntaxQualityGate(),
    });

    const change = result.proposal.changes[0];
    expect(change?.materializationStatus).toBe("materialized");
    expect(change?.materializationErrors).toBeUndefined();
    expect(change?.generatedSource).toBe(GOOD);
  });

  test("scoped run clears stale source on a NON-materializable out-of-scope change", async () => {
    // A declarative change carrying STALE materialization artifacts (it was an
    // action that got materialized, then edited to a declarative target). A
    // SCOPED materialization of a DIFFERENT change must still clear the stale
    // source so ProposalFileWriter never writes it at graduation — the scope
    // protects already-good MATERIALIZABLE candidates, not invalid declarative
    // state. (Regression for codex R3 on the scoped-materialization PR.)
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
      {
        target: "entity",
        operation: "create",
        name: "stale_entity",
        generatedSource: "export const stale = 1;",
        materializationStatus: "materialized",
      },
    ]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider: makeProvider(GOOD),
      qualityGate: createSyntaxQualityGate(),
      changeNames: ["deduct_inventory"], // scope to the action only
    });

    const action = result.proposal.changes.find((c) => c.name === "deduct_inventory");
    const stale = result.proposal.changes.find((c) => c.name === "stale_entity");
    expect(action?.materializationStatus).toBe("materialized");
    // The out-of-scope, now-declarative change had its stale artifacts CLEARED.
    expect(stale?.generatedSource).toBeUndefined();
    expect(stale?.materializationStatus).toBeUndefined();
    expect(stale?.materializationErrors).toBeUndefined();
    expect(result.outcomes.find((o) => o.changeName === "stale_entity")?.status).toBe("skipped");
    // The input proposal is never mutated.
    expect(input.changes[1]?.generatedSource).toBe("export const stale = 1;");
  });
});
