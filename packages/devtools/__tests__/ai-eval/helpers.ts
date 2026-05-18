/**
 * Test helpers shared across the ai-eval test suite.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AICompletionOptions, AICompletionResult, AIService } from "@linchkit/core";
import type { EvalFixture, InlineCatalogAction, OntologyRegistryLike } from "../../src/ai-eval";

/** Build a Strict-JSON AI response that the intent scenario will accept. */
export function buildOkResponse(opts: {
  amount?: number;
  confidence?: number;
  action?: string;
  explanation?: string;
}): string {
  return JSON.stringify({
    action: opts.action ?? "create_purchase_request",
    input: opts.amount === undefined ? {} : { amount: opts.amount },
    confidence: opts.confidence ?? 0.9,
    explanation: opts.explanation ?? "ok",
  });
}

/** Inline catalog with two purchase actions — enough for happy + alt paths. */
export function inlineCatalog(): InlineCatalogAction[] {
  return [
    {
      name: "create_purchase_request",
      entity: "purchase_request",
      label: "Create Purchase Request",
      description: "Submit a new purchase request",
      input: {
        amount: { type: "number", required: true, label: "Amount" },
        notes: { type: "string", required: false, label: "Notes" },
      },
    },
    {
      name: "approve_purchase_request",
      entity: "purchase_request",
      label: "Approve Purchase Request",
      input: {
        id: { type: "string", required: true, label: "Request ID" },
      },
    },
  ];
}

/** Tiny ontology stub — the live path uses `inline:` source by default. */
export function makeOntology(): OntologyRegistryLike {
  return {
    listEntities: () => [],
    actionsFor: () => [],
  };
}

/**
 * Mock AIService that picks a response by substring match against the LAST
 * user message. Falls back to a refusal JSON when nothing matches so the
 * scenario adapter still parses successfully.
 */
export function makeMockAi(
  responses: Record<string, string>,
  onCall?: (opts: AICompletionOptions) => void,
): AIService {
  return {
    configured: true,
    defaultProvider: "mock",
    providerNames: ["mock"],
    async complete(options: AICompletionOptions): Promise<AICompletionResult> {
      onCall?.(options);
      const lastUser = [...options.messages].reverse().find((m) => m.role === "user");
      const userText = lastUser?.content ?? "";
      let body = JSON.stringify({
        action: null,
        input: {},
        confidence: 0,
        explanation: "no match in mock",
      });
      for (const [needle, value] of Object.entries(responses)) {
        if (userText.includes(needle)) {
          body = value;
          break;
        }
      }
      return {
        content: body,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        model: "mock-model",
        provider: "mock",
        duration: 0,
      };
    },
  };
}

/** Persist fixtures to disk under `<dir>/<scenario>/<tag>/<id>.json`. */
export async function fixturesDirFromMap(dir: string, fixtures: EvalFixture[]): Promise<void> {
  for (const fx of fixtures) {
    const tag = fx.tags[0] ?? "untagged";
    const target = path.join(dir, fx.scenario, tag, `${fx.id}.json`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(fx, null, 2), "utf8");
  }
}
