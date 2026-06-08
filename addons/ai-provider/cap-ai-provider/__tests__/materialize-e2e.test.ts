/**
 * E2E smoke test for G5 code materialization — real model call.
 *
 * Exercises the full live materialize path with a REAL AI provider:
 *   createAIService → createCodeGenerationProvider → materializeProposalChanges
 *   → Phase-2 syntax gate.
 * It proves the configured provider actually returns USABLE source (not just
 * syntactically valid in unit fakes).
 *
 * GATED: requires VOLCENGINE_API_KEY. Without it the suite is skipped, so CI
 * (no key) never calls a real model. Run:
 *   VOLCENGINE_API_KEY=sk-xxx bun test addons/ai-provider/cap-ai-provider/__tests__/materialize-e2e.test.ts
 *
 * Mirrors `ai-service-e2e.test.ts`: a Volcengine subscription/auth/billing
 * failure SKIPS (returns early) rather than failing, so an expired key doesn't
 * turn this into a red build.
 */
import { describe, expect, it } from "bun:test";
import type { AIServiceConfig, ProposalDefinition } from "@linchkit/core";
import { createSyntaxQualityGate, materializeProposalChanges } from "@linchkit/core/server";
import { createAIService } from "../src/ai-service";
import { createCodeGenerationProvider } from "../src/code-generation-provider";

const apiKey = process.env.VOLCENGINE_API_KEY;

const config: AIServiceConfig = {
  defaultProvider: "volcengine",
  providers: {
    volcengine: {
      type: "openai",
      apiKey,
      endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3",
      defaultModel: "ark-code-latest",
    },
  },
};

/** True if the error is a Volcengine subscription/auth/billing failure → skip. */
function isSubscriptionError(err: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 3 && current != null; i++) {
    if (current instanceof Error) {
      messages.push(current.message);
      const code = (current as { code?: unknown }).code;
      if (code != null) messages.push(String(code));
      current = (current as { cause?: unknown }).cause;
    } else {
      // A non-Error throw (e.g. a plain `{ error, status }` object) — stringify it
      // so its fields are searchable. `String({})` is "[object Object]", which the
      // regex can't match, so JSON-serialize objects; fall back to String() for
      // primitives / circular structures.
      let text: string;
      if (typeof current === "object") {
        try {
          text = JSON.stringify(current);
        } catch {
          text = String(current);
        }
      } else {
        text = String(current);
      }
      messages.push(text);
      break;
    }
  }
  return /subscription|coding plan|\b(unauthorized|forbidden)\b|\b40[13]\b|payment required|billing/i.test(
    messages.join(" | "),
  );
}

async function runWithSubscriptionSkip<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isSubscriptionError(err)) {
      console.warn("[e2e] skipped: Volcengine subscription/auth error");
      return undefined;
    }
    throw err;
  }
}

function makeDraft(): ProposalDefinition {
  const now = new Date();
  return {
    id: "prop-e2e-materialize",
    title: "Add deduct_inventory action",
    description:
      "When a purchase order is approved, deduct the ordered quantity from the " +
      "product's inventory. Implement the handler fully.",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability: "cap-demo",
    changeType: "minor",
    changes: [{ target: "action", operation: "create", name: "deduct_inventory" }],
    impact: {
      schemasAffected: [],
      actionsAffected: ["deduct_inventory"],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  } as ProposalDefinition;
}

describe.skipIf(!apiKey)("G5 materialize E2E — Volcengine", () => {
  const ai = createAIService(config);
  const provider = createCodeGenerationProvider(ai);

  it("generates syntactically-valid candidate source for an action change", async () => {
    const result = await runWithSubscriptionSkip(() =>
      materializeProposalChanges({
        proposal: makeDraft(),
        provider,
        qualityGate: createSyntaxQualityGate(),
        maxRetries: 3,
      }),
    );
    if (!result) return; // subscription/auth skip

    expect(result.allMaterialized).toBe(true);
    expect(result.outcomes[0]?.status).toBe("materialized");
    const source = result.proposal.changes[0]?.generatedSource;
    expect(typeof source).toBe("string");
    expect((source ?? "").trim().length).toBeGreaterThan(0);
    // Passed the syntax gate (allMaterialized), so it's at least buildable TS.
  }, 60_000);
});
