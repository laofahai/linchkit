/**
 * Proposal code-materialization SCOPE — REAL server-assembly smoke test.
 *
 * Companion to `proposal-materialize-smoke.test.ts`. That suite proves the
 * happy/guard paths of `POST /api/proposals/:id/materialize` through the
 * canonical `createServer(...)` factory. This one pins the ADDITIVE
 * `{ changeNames?: string[] }` request body: scoping materialization to a subset
 * of changes so retrying ONE failed change does NOT regenerate — and risk
 * regressing — the already-good ones.
 *
 * It exercises the SAME real components end-to-end (real `createCommandLayer`,
 * real REST surface, the process-wide shared `ProposalEngine`, the real syntax
 * quality gate). The ONLY stubbed seam is the AI model: a fake `AIService`
 * (`configured: true`) whose `complete()` returns a `defineAction(...)` source
 * that ENCODES which call produced it (a module-level call counter baked into
 * the generated `name:`), so first-vs-second output is distinguishable while the
 * source still parses through the real Bun.Transpiler gate.
 *
 * Core assertions:
 *   1. First POST (no body) materializes BOTH changes (back-compat = all).
 *   2. Second POST `{ changeNames: [A.name] }` regenerates ONLY A (new output),
 *      reports B with its CARRIED-FORWARD durable status, and leaves B's
 *      persisted `generatedSource` UNCHANGED — provider call count goes up by
 *      exactly 1. Status stays draft.
 *   3. Empty body `{}` again materializes ALL (back-compat).
 *   4. A garbage/unknown `changeNames` is sanitized → materialize all.
 *   5. A scoped retry of A does NOT hide a still-failed B: B surfaces as
 *      `failed` and `allMaterialized` stays false (codex regression).
 *
 * Dispatch is `app.handle(new Request(...))` (in-process, port-free) — never
 * `app.listen(PORT)` (a bound socket per suite SEGFAULTS the batched run). All
 * fixtures are GLOBALLY UNIQUE (counter + Date.now suffix) because the shared
 * `ProposalEngine` persists across the batched run.
 */

import { describe, expect, test } from "bun:test";
import type {
  AICompletionOptions,
  AICompletionResult,
  AIService,
  CommandLayer,
  EntityDefinition,
  ProposalDefinition,
} from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { getSharedProposalEngine } from "../src/proposal-api";
import { createServer } from "../src/server";

const BASE = "http://local.test";

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: { title: { type: "string", required: true, label: "Title" } },
};

// ── Globally-unique fixtures (shared-engine dedup safety) ────

let fixtureCounter = 0;
/** Mint a globally-unique (capability, two action names, title) per test. */
function uniqueFixture(): {
  capability: string;
  actionA: string;
  actionB: string;
  title: string;
} {
  fixtureCounter += 1;
  const tag = `${Date.now().toString(36)}_${fixtureCounter}`;
  return {
    capability: `cap-materialize-scope-${tag}`,
    actionA: `materialize_scope_action_a_${tag}`,
    actionB: `materialize_scope_action_b_${tag}`,
    title: `Materialize scope proposal ${tag}`,
  };
}

/**
 * Seed a DRAFT proposal carrying TWO materializable (action/create) changes,
 * A and B, into the process-wide shared `ProposalEngine` — the same engine the
 * production route reads/writes. Returns the proposal id + both change names.
 */
function seedDraftProposalWithTwoChanges(): {
  id: string;
  actionA: string;
  actionB: string;
} {
  const { capability, actionA, actionB, title } = uniqueFixture();
  const proposal = getSharedProposalEngine().createProposal({
    title,
    description: "Smoke: scope materialization to a subset of action changes.",
    author: { type: "ai", id: "smoke-detector", name: "Smoke Detector" },
    capability,
    changeType: "minor",
    changes: [
      { target: "action", operation: "create", name: actionA },
      { target: "action", operation: "create", name: actionB },
    ],
  });
  return { id: proposal.id, actionA, actionB };
}

// ── Fake AIService whose output encodes the call index ───────

/**
 * Build a `defineAction(...)` source that BAKES IN the call index, so two
 * successive generations are textually distinguishable while still being valid
 * TypeScript that passes the real syntax quality gate (Bun.Transpiler). The
 * index lives in the action `name:` AND the returned payload.
 */
function generatedSourceForCall(callIndex: number): string {
  return [
    'import { defineAction } from "@linchkit/core";',
    "",
    "export const generated = defineAction({",
    `  name: "deduct_inventory_call_${callIndex}",`,
    "  handler: async () => {",
    `    return { ok: true, call: ${callIndex} };`,
    "  },",
    "});",
    "",
  ].join("\n");
}

/**
 * A configured fake `AIService`. Each `complete()` call returns source that
 * encodes a fresh, monotonically-increasing call index, so a regenerated change
 * gets DIFFERENT source than its prior materialization — letting the test prove
 * "A regenerated, B preserved". `calls.count` tracks invocations so the test can
 * assert the provider ran exactly once on a scoped retry.
 */
function makeFakeAIService(): { ai: AIService; calls: { count: number } } {
  const calls = { count: 0 };
  const ai: AIService = {
    configured: true,
    defaultProvider: "smoke",
    providerNames: ["smoke"],
    complete(_options: AICompletionOptions): Promise<AICompletionResult> {
      calls.count += 1;
      const result: AICompletionResult = {
        content: generatedSourceForCall(calls.count),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: "smoke-model",
        provider: "smoke",
        duration: 0,
      };
      return Promise.resolve(result);
    },
  };
  return { ai, calls };
}

/**
 * A configured fake whose `complete()` ALWAYS returns syntactically-broken
 * source, so every materializable change FAILS the real syntax quality gate.
 * Used to drive changes into the durable `failed` state through the real
 * pipeline before a scoped retry of just one of them.
 */
function makeBrokenAIService(): AIService {
  return {
    configured: true,
    defaultProvider: "smoke",
    providerNames: ["smoke"],
    complete(_options: AICompletionOptions): Promise<AICompletionResult> {
      return Promise.resolve({
        content: "export const x = (((;", // never parses → fails the syntax gate
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: "smoke-model",
        provider: "smoke",
        duration: 0,
      });
    },
  };
}

/**
 * Allow-all permission middleware. The materialize dispatch uses
 * `skipActionSlots: true`, which is fail-closed without a permission slot; this
 * minimal pass-through stands in for "the caller is authorized".
 */
function grantPermission(commandLayer: CommandLayer): void {
  commandLayer.use({
    name: "smoke_allow_materialize_scope",
    slot: "permission",
    handler: async (_ctx, next) => {
      await next();
    },
  });
}

/** Build the real server via the canonical factory. */
function buildApp(opts: { aiService: AIService }): {
  handle: (req: Request) => Promise<Response>;
} {
  const store = new InMemoryStore();
  const executor = createActionExecutor({
    dataProvider: store,
    executionLogger: new InMemoryExecutionLogger(),
  });
  const commandLayer = createCommandLayer({ executor });
  grantPermission(commandLayer);
  const graphqlSchema = buildGraphQLSchema([taskSchema], {
    executor,
    commandLayer,
    dataProvider: store,
  });
  return createServer(graphqlSchema, { executor, commandLayer, aiService: opts.aiService });
}

interface MaterializeJson {
  success: boolean;
  data?: {
    proposalId?: string;
    allMaterialized?: boolean;
    outcomes?: Array<{ changeName: string; target: string; status: string }>;
    proposal?: {
      status?: string;
      changes?: Array<{ name: string; generatedSource?: string }>;
    };
  };
  error?: { message?: string; code?: string };
}

/**
 * POST the materialize endpoint with an OPTIONAL body. When `body` is omitted no
 * payload is sent (the empty-body "materialize all" path); otherwise the value
 * is JSON-encoded. Reads the response as text first so a non-JSON crash surfaces
 * its raw body instead of an opaque SyntaxError.
 */
async function postMaterialize(
  app: { handle: (req: Request) => Promise<Response> },
  id: string,
  body?: unknown,
): Promise<{ status: number; json: MaterializeJson }> {
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const res = await app.handle(new Request(`${BASE}/api/proposals/${id}/materialize`, init));
  const text = await res.text();
  let json: MaterializeJson;
  try {
    json = JSON.parse(text) as MaterializeJson;
  } catch {
    throw new Error(`materialize returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

/** Read a change's persisted `generatedSource` back out of the shared engine. */
function readPersistedSource(id: string, changeName: string): string | undefined {
  const proposal: ProposalDefinition = getSharedProposalEngine().getProposal(id);
  return proposal.changes.find((c) => c.name === changeName)?.generatedSource;
}

describe("POST /api/proposals/:id/materialize — changeNames scope smoke", () => {
  test("scoped retry regenerates only the named change; out-of-scope is preserved untouched", async () => {
    const { ai, calls } = makeFakeAIService();
    const app = buildApp({ aiService: ai });
    const { id, actionA, actionB } = seedDraftProposalWithTwoChanges();

    // ── First POST (no body) → BOTH A and B materialized (back-compat = all). ──
    const first = await postMaterialize(app, id);
    expect(first.status).toBe(200);
    expect(first.json.success).toBe(true);
    expect(first.json.data?.allMaterialized).toBe(true);

    const firstA = first.json.data?.outcomes?.find((o) => o.changeName === actionA);
    const firstB = first.json.data?.outcomes?.find((o) => o.changeName === actionB);
    expect(firstA?.status).toBe("materialized");
    expect(firstB?.status).toBe("materialized");
    // Two materializable changes → exactly two provider calls.
    expect(calls.count).toBe(2);

    // Capture the first-pass persisted source for each change.
    const aSourceAfterFirst = readPersistedSource(id, actionA);
    const bSourceAfterFirst = readPersistedSource(id, actionB);
    expect(aSourceAfterFirst).toBeDefined();
    expect(bSourceAfterFirst).toBeDefined();
    // The two changes got distinct call-encoded sources.
    expect(aSourceAfterFirst).not.toBe(bSourceAfterFirst);

    // ── Second POST `{ changeNames: [A] }` → ONLY A regenerated; B untouched. ──
    const callsBeforeScoped = calls.count;
    const second = await postMaterialize(app, id, { changeNames: [actionA] });
    expect(second.status).toBe(200);
    expect(second.json.success).toBe(true);
    // Both are materialized (A regenerated, B carried forward), so allMaterialized.
    expect(second.json.data?.allMaterialized).toBe(true);

    const secondA = second.json.data?.outcomes?.find((o) => o.changeName === actionA);
    const secondB = second.json.data?.outcomes?.find((o) => o.changeName === actionB);
    expect(secondA?.status).toBe("materialized");
    // B is out-of-scope but reports its CARRIED-FORWARD durable status (it
    // succeeded in pass 1) — NOT a blanket "skipped" that would hide a failure.
    expect(secondB?.status).toBe("materialized");

    // Provider called exactly ONCE more — only A regenerated.
    expect(calls.count).toBe(callsBeforeScoped + 1);

    // A's persisted source CHANGED (fresh provider output)…
    const aSourceAfterScoped = readPersistedSource(id, actionA);
    expect(aSourceAfterScoped).toBeDefined();
    expect(aSourceAfterScoped).not.toBe(aSourceAfterFirst);
    // …while B's persisted source is UNCHANGED (out-of-scope, preserved untouched).
    const bSourceAfterScoped = readPersistedSource(id, actionB);
    expect(bSourceAfterScoped).toBe(bSourceAfterFirst);

    // SAFETY: still a draft — never auto-advanced.
    expect(second.json.data?.proposal?.status).toBe("draft");
    expect(getSharedProposalEngine().getProposal(id).status).toBe("draft");
  });

  test("empty body {} still materializes ALL changes (back-compat)", async () => {
    const { ai, calls } = makeFakeAIService();
    const app = buildApp({ aiService: ai });
    const { id, actionA, actionB } = seedDraftProposalWithTwoChanges();

    const res = await postMaterialize(app, id, {});
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.data?.allMaterialized).toBe(true);

    const a = res.json.data?.outcomes?.find((o) => o.changeName === actionA);
    const b = res.json.data?.outcomes?.find((o) => o.changeName === actionB);
    expect(a?.status).toBe("materialized");
    expect(b?.status).toBe("materialized");
    // An empty body is treated as absent → ALL materializable changes generated.
    expect(calls.count).toBe(2);

    expect(readPersistedSource(id, actionA)).toBeDefined();
    expect(readPersistedSource(id, actionB)).toBeDefined();
    expect(getSharedProposalEngine().getProposal(id).status).toBe("draft");
  });

  test("garbage/all-unknown changeNames is sanitized → materialize all (never trusted)", async () => {
    const { ai, calls } = makeFakeAIService();
    const app = buildApp({ aiService: ai });
    const { id, actionA, actionB } = seedDraftProposalWithTwoChanges();

    // Defensive sanitation, two layers:
    //   1. Non-string entries (123, null, an object that embeds a real name) are
    //      DROPPED at the route — a client cannot smuggle a name via a non-string.
    //   2. The surviving strings ("   " is empty-after-trim → dropped;
    //      "no_such_change" matches no change on this proposal) are filtered
    //      against the proposal's ACTUAL change names in the orchestrator.
    // After both layers NOTHING survives → the scope degrades to "materialize all"
    // rather than scoping to a phantom set that would silently skip everything.
    const res = await postMaterialize(app, id, {
      changeNames: [123, null, { name: actionA }, "   ", "no_such_change"],
    });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.data?.allMaterialized).toBe(true);

    const a = res.json.data?.outcomes?.find((o) => o.changeName === actionA);
    const b = res.json.data?.outcomes?.find((o) => o.changeName === actionB);
    // No usable scope survived → BOTH real changes materialized (back-compat).
    expect(a?.status).toBe("materialized");
    expect(b?.status).toBe("materialized");
    expect(calls.count).toBe(2);

    // Both real changes got candidate source; draft untouched.
    expect(readPersistedSource(id, actionA)).toBeDefined();
    expect(readPersistedSource(id, actionB)).toBeDefined();
    expect(getSharedProposalEngine().getProposal(id).status).toBe("draft");
  });

  test("scoped retry of A does NOT hide a still-failed B → allMaterialized stays false", async () => {
    // Regression for the codex review: an out-of-scope change that is still
    // `failed` must surface as "failed" in the outcomes and keep
    // `allMaterialized` false — a scoped retry of A must NOT misreport the whole
    // proposal as fully materialized while B is still broken.
    const { id, actionA, actionB } = seedDraftProposalWithTwoChanges();

    // Pass 1: a BROKEN-source provider fails BOTH A and B (durable "failed").
    // The shared, process-wide ProposalEngine persists that state across apps.
    const brokenApp = buildApp({ aiService: makeBrokenAIService() });
    const first = await postMaterialize(brokenApp, id);
    expect(first.status).toBe(200);
    expect(first.json.data?.allMaterialized).toBe(false);
    expect(first.json.data?.outcomes?.find((o) => o.changeName === actionA)?.status).toBe("failed");
    expect(first.json.data?.outcomes?.find((o) => o.changeName === actionB)?.status).toBe("failed");

    // Pass 2: scope a retry to A only, now with a GOOD-source provider. A
    // succeeds; B is out-of-scope and STILL failed.
    const goodApp = buildApp({ aiService: makeFakeAIService().ai });
    const second = await postMaterialize(goodApp, id, { changeNames: [actionA] });
    expect(second.status).toBe(200);

    const a = second.json.data?.outcomes?.find((o) => o.changeName === actionA);
    const b = second.json.data?.outcomes?.find((o) => o.changeName === actionB);
    expect(a?.status).toBe("materialized");
    // B carries forward its durable "failed" — NOT hidden as "skipped".
    expect(b?.status).toBe("failed");
    // The whole-proposal summary is honest: B is still broken.
    expect(second.json.data?.allMaterialized).toBe(false);

    // A now has source; B still has none (its failed materialization persisted).
    expect(readPersistedSource(id, actionA)).toBeDefined();
    expect(readPersistedSource(id, actionB)).toBeUndefined();
    expect(getSharedProposalEngine().getProposal(id).status).toBe("draft");
  });

  test("scoping A on a never-materialized proposal leaves B un-generated → allMaterialized false", async () => {
    // Regression for codex R2: allMaterialized must reflect the WHOLE proposal,
    // not just the scoped round. With a FIRST-EVER scoped materialization of A,
    // the out-of-scope B is a materializable change that was NEVER generated (no
    // source, no status) — the proposal is NOT fully materialized, so
    // allMaterialized must be false even though nothing "failed" this round.
    const { ai } = makeFakeAIService();
    const app = buildApp({ aiService: ai });
    const { id, actionA, actionB } = seedDraftProposalWithTwoChanges();

    const res = await postMaterialize(app, id, { changeNames: [actionA] });
    expect(res.status).toBe(200);
    expect(res.json.data?.outcomes?.find((o) => o.changeName === actionA)?.status).toBe(
      "materialized",
    );
    // B never generated → not materialized → drags allMaterialized false.
    expect(res.json.data?.allMaterialized).toBe(false);
    expect(readPersistedSource(id, actionA)).toBeDefined();
    expect(readPersistedSource(id, actionB)).toBeUndefined();
    expect(getSharedProposalEngine().getProposal(id).status).toBe("draft");
  });
});
