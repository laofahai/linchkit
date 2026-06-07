import { describe, expect, test } from "bun:test";
import type { CodeGenerationProvider } from "../../ai/proposal-code-generator";
import { createSyntaxQualityGate } from "../../engine/code-quality-gate";
import { isMaterializable, materializeProposalChanges } from "../../engine/proposal-materializer";
import type { ProposalChange, ProposalDefinition } from "../../types/proposal";

function makeProposal(changes: ProposalChange[]): ProposalDefinition {
  const now = new Date();
  return {
    id: "prop-mat-1",
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

/** Fake provider returning a fixed sequence (sticks on the last entry). */
function makeProvider(responses: string[]): {
  provider: CodeGenerationProvider;
  calls: Array<{ prompt: string; context?: string }>;
} {
  let i = 0;
  const calls: Array<{ prompt: string; context?: string }> = [];
  const provider: CodeGenerationProvider = {
    async generateCode(prompt: string, context?: string): Promise<string> {
      calls.push({ prompt, context });
      const r = responses[Math.min(i, responses.length - 1)] ?? "";
      i += 1;
      return r;
    },
  };
  return { provider, calls };
}

const GOOD = "export const deduct_inventory = 1;";
const BAD = "export const a = {"; // syntax error

describe("isMaterializable", () => {
  test("action/event/flow create|update are materializable; declarative + delete are not", () => {
    expect(isMaterializable({ target: "action", operation: "create", name: "a" })).toBe(true);
    expect(isMaterializable({ target: "event", operation: "update", name: "e" })).toBe(true);
    expect(isMaterializable({ target: "flow", operation: "create", name: "f" })).toBe(true);
    expect(isMaterializable({ target: "entity", operation: "create", name: "x" })).toBe(false);
    expect(isMaterializable({ target: "rule", operation: "create", name: "r" })).toBe(false);
    expect(isMaterializable({ target: "action", operation: "delete", name: "a" })).toBe(false);
  });
});

describe("materializeProposalChanges", () => {
  test("attaches generatedSource to a materializable change without mutating the input", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);
    const { provider } = makeProvider([GOOD]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider,
      qualityGate: createSyntaxQualityGate(),
    });

    expect(result.allMaterialized).toBe(true);
    expect(result.outcomes[0]?.status).toBe("materialized");
    expect(result.proposal.changes[0]?.generatedSource).toBe(GOOD);
    // input untouched
    expect(input.changes[0]?.generatedSource).toBeUndefined();
  });

  test("skips declarative targets and delete operations", async () => {
    const input = makeProposal([
      { target: "rule", operation: "create", name: "late_fee" },
      { target: "action", operation: "delete", name: "old_action" },
    ]);
    const { provider, calls } = makeProvider([GOOD]);

    const result = await materializeProposalChanges({ proposal: input, provider });

    expect(result.outcomes.every((o) => o.status === "skipped")).toBe(true);
    expect(calls).toHaveLength(0); // provider never called
    expect(result.proposal.changes.every((c) => c.generatedSource === undefined)).toBe(true);
  });

  test("retries on a gate failure and succeeds on a later attempt", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);
    const { provider } = makeProvider([BAD, GOOD]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider,
      qualityGate: createSyntaxQualityGate(),
      maxRetries: 3,
    });

    expect(result.outcomes[0]?.status).toBe("materialized");
    expect(result.outcomes[0]?.attempts).toBe(2);
    expect(result.proposal.changes[0]?.generatedSource).toBe(GOOD);
  });

  test("fails after exhausting retries when the gate never passes", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);
    const { provider } = makeProvider([BAD]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider,
      qualityGate: createSyntaxQualityGate(),
      maxRetries: 2,
    });

    expect(result.allMaterialized).toBe(false);
    expect(result.outcomes[0]?.status).toBe("failed");
    expect(result.outcomes[0]?.attempts).toBe(2);
    expect((result.outcomes[0]?.errors ?? []).length).toBeGreaterThan(0);
    expect(result.proposal.changes[0]?.generatedSource).toBeUndefined();
  });

  test("strips a markdown code fence from the generated source", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);
    const { provider } = makeProvider(["```ts\nexport const deduct_inventory = 1;\n```"]);

    const result = await materializeProposalChanges({
      proposal: input,
      provider,
      qualityGate: createSyntaxQualityGate(),
    });

    expect(result.proposal.changes[0]?.generatedSource).toBe("export const deduct_inventory = 1;");
  });

  test("forwards context to the provider as the system message", async () => {
    const input = makeProposal([
      { target: "action", operation: "create", name: "deduct_inventory" },
    ]);
    const { provider, calls } = makeProvider([GOOD]);

    await materializeProposalChanges({ proposal: input, provider, context: "PROJECT CONVENTIONS" });

    expect(calls[0]?.context).toBe("PROJECT CONVENTIONS");
  });
});
