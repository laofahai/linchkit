/**
 * Proposal code-materialization — REAL server-assembly smoke test (G5 Phase 4).
 *
 * The sibling `proposal-materialize-api.test.ts` pins the route in isolation
 * (a hand-built Elysia app with an injected fake engine + `resolveProvider`).
 * This smoke test instead drives `POST /api/proposals/:id/materialize` through
 * the canonical `createServer(...)` factory — the SAME assembly path
 * `http-transport.ts` boots in production — to prove the most safety-sensitive
 * evolution endpoint (it AI-generates source) is actually wired into the real
 * server and fails CLOSED.
 *
 * It exercises real components end-to-end: a real `createCommandLayer`, a real
 * GraphQL schema, the real REST surface, the process-wide shared
 * `ProposalEngine` (via `getSharedProposalEngine()`), and the real syntax
 * quality gate (Bun.Transpiler). The ONLY seam stubbed is the AI model itself:
 * a fake `AIService` (`configured: true`) whose `complete()` returns a canned
 * `defineAction(...)` source — injected through the `aiService` ServerOptions
 * field, which `createServer` threads into `mountProposalMaterializeAPI`, where
 * the default `resolveProvider` builds a real `createCodeGenerationProvider(ai)`
 * over it. No real model call, no `resolveProvider` override — the provider
 * injection seam is the production one.
 *
 * Safety invariant under test: materialization is DRAFT-only and produces a
 * CANDIDATE only. The draft must NEVER be auto-submitted/validated/approved/
 * graduated/committed — its status stays `draft`. The permission slot is never
 * skipped: without a permission middleware the dispatch fails closed and NO
 * code is generated.
 *
 * Dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite
 * SEGFAULTS the batched addons run.
 *
 * Shared-singleton safety: the shared `ProposalEngine` is process-wide and
 * persists across the batched run, so every fixture (capability + change name +
 * proposal title) is GLOBALLY UNIQUE via a per-test counter suffix to avoid
 * collisions with other suites that touch the same engine.
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

// The materialize route resolves the shared `ProposalEngine` from this module's
// `proposal-api` (no engine override is threaded through `createServer`), so we
// seed + read governance state back through the SAME handle the route mutates.

const BASE = "http://local.test";

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: { title: { type: "string", required: true, label: "Title" } },
};

/**
 * A syntactically-valid `defineAction(...)` source the fake model "generates".
 * It must pass the REAL syntax quality gate (Bun.Transpiler), so it is real,
 * parseable TypeScript — not a placeholder. The route attaches it verbatim to
 * the draft's change as `generatedSource`.
 */
const GENERATED_SOURCE = [
  'import { defineAction } from "@linchkit/core";',
  "",
  "export const generated = defineAction({",
  '  name: "deduct_inventory",',
  "  handler: async () => {",
  "    return { ok: true };",
  "  },",
  "});",
  "",
].join("\n");

/**
 * What the materializer actually PERSISTS for the source above. The real
 * `stripCodeFence` normalizer (proposal-materializer.ts) runs `raw.trim()` on
 * every model response — it strips any markdown fence AND surrounding
 * whitespace — so the trailing newline in `GENERATED_SOURCE` is removed before
 * it is attached to the change. Asserting against the normalized form documents
 * that real pipeline behavior instead of hiding it.
 */
const EXPECTED_SOURCE = GENERATED_SOURCE.trim();

// ── Globally-unique fixtures (shared-engine dedup safety) ────

let counter = 0;
/** Mint a globally-unique (capability, action name, title) triple per test. */
function uniqueFixture(): { capability: string; actionName: string; title: string } {
  counter += 1;
  const tag = `${Date.now().toString(36)}_${counter}`;
  return {
    capability: `cap-materialize-smoke-${tag}`,
    actionName: `materialize_smoke_action_${tag}`,
    title: `Materialize smoke proposal ${tag}`,
  };
}

/**
 * Seed a DRAFT proposal carrying ONE materializable (action/create) change into
 * the process-wide shared `ProposalEngine` — the same engine the production
 * route reads/writes. Returns the proposal id + the unique change name.
 */
function seedDraftProposal(): { id: string; actionName: string } {
  const { capability, actionName, title } = uniqueFixture();
  const proposal = getSharedProposalEngine().createProposal({
    title,
    description: "Smoke: materialize candidate source for a draft action change.",
    author: { type: "ai", id: "smoke-detector", name: "Smoke Detector" },
    capability,
    changeType: "minor",
    changes: [{ target: "action", operation: "create", name: actionName }],
  });
  return { id: proposal.id, actionName };
}

// ── Fake AIService (the only stubbed seam) ───────────────────

/**
 * A configured fake `AIService` whose `complete()` returns the canned source.
 * `createServer` → `mountProposalMaterializeAPI`'s default `resolveProvider`
 * builds a REAL `createCodeGenerationProvider(this)` over it, so the provider
 * code path is production code — only the model output is canned. `calls`
 * tracks invocations so guard paths can assert NO generation happened.
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
        content: GENERATED_SOURCE,
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
 * Register an allow-all permission middleware. The materialize dispatch uses
 * `skipActionSlots: true`, which is fail-closed: the CommandLayer rejects it
 * (`PERMISSION.MIDDLEWARE_MISSING`) unless a permission middleware is present.
 * In a real deployment cap-permission provides this slot; here a minimal
 * pass-through stands in for "the caller is authorized".
 */
function grantPermission(commandLayer: CommandLayer): void {
  commandLayer.use({
    name: "smoke_allow_materialize",
    slot: "permission",
    handler: async (_ctx, next) => {
      await next();
    },
  });
}

/** Build the real server via the canonical factory. */
function buildApp(opts: { aiService?: AIService; withPermission?: boolean } = {}): {
  handle: (req: Request) => Promise<Response>;
} {
  const { aiService, withPermission = true } = opts;
  const store = new InMemoryStore();
  const executor = createActionExecutor({
    dataProvider: store,
    executionLogger: new InMemoryExecutionLogger(),
  });
  const commandLayer = createCommandLayer({ executor });
  if (withPermission) {
    grantPermission(commandLayer);
  }
  const graphqlSchema = buildGraphQLSchema([taskSchema], {
    executor,
    commandLayer,
    dataProvider: store,
  });
  return createServer(graphqlSchema, { executor, commandLayer, aiService });
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

async function postMaterialize(
  app: { handle: (req: Request) => Promise<Response> },
  id: string,
): Promise<{ status: number; json: MaterializeJson }> {
  const res = await app.handle(
    new Request(`${BASE}/api/proposals/${id}/materialize`, { method: "POST" }),
  );
  // Read the body as text first: a 500 / assembly crash can return non-JSON,
  // and a bare `res.json()` would throw an opaque SyntaxError that masks the
  // real failure. Surface the raw body instead.
  const body = await res.text();
  let json: MaterializeJson;
  try {
    json = JSON.parse(body) as MaterializeJson;
  } catch {
    throw new Error(`materialize returned non-JSON (status ${res.status}): ${body.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

/** Read a draft's change back out of the shared engine (post-dispatch state). */
function readChange(id: string, actionName: string): { generatedSource?: string } | undefined {
  const proposal: ProposalDefinition = getSharedProposalEngine().getProposal(id);
  return proposal.changes.find((c) => c.name === actionName);
}

describe("POST /api/proposals/:id/materialize — real createServer smoke", () => {
  test("happy path: draft → 200, candidate source attached, status stays draft", async () => {
    const { ai, calls } = makeFakeAIService();
    const app = buildApp({ aiService: ai });
    const { id, actionName } = seedDraftProposal();

    const { status, json } = await postMaterialize(app, id);

    // The endpoint succeeds end-to-end through the real assembly.
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.proposalId).toBe(id);
    expect(json.data?.allMaterialized).toBe(true);

    // The action change was materialized (not skipped/failed).
    const outcome = json.data?.outcomes?.find((o) => o.changeName === actionName);
    expect(outcome?.status).toBe("materialized");
    expect(outcome?.target).toBe("action");

    // The returned proposal carries the candidate source on its change.
    const returnedChange = json.data?.proposal?.changes?.find((c) => c.name === actionName);
    expect(returnedChange?.generatedSource).toBe(EXPECTED_SOURCE);

    // SAFETY: the proposal must NEVER be auto-advanced past draft.
    expect(json.data?.proposal?.status).toBe("draft");

    // The real provider was called exactly once (one materializable change).
    expect(calls.count).toBe(1);

    // The candidate source was persisted back onto the shared draft, and the
    // draft is still a draft in the engine (read back through the same handle
    // the route mutated) — no auto-submit/approve/graduate.
    const persisted = readChange(id, actionName);
    expect(persisted?.generatedSource).toBe(EXPECTED_SOURCE);
    expect(getSharedProposalEngine().getProposal(id).status).toBe("draft");
  });

  test("permission enforced end-to-end: no middleware → fail closed, NO code generated", async () => {
    // A configured AI service IS wired, so a leak would actually call the model
    // and mutate the draft. The permission slot must reject FIRST.
    const { ai, calls } = makeFakeAIService();
    const app = buildApp({ aiService: ai, withPermission: false });
    const { id, actionName } = seedDraftProposal();

    const { status, json } = await postMaterialize(app, id);

    // skipActionSlots dispatch with no permission middleware fails closed.
    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("PERMISSION.MIDDLEWARE_MISSING");

    // No model call, no candidate source persisted — the guard ran before any
    // provider build or engine write.
    expect(calls.count).toBe(0);
    const persisted = readChange(id, actionName);
    expect(persisted?.generatedSource).toBeUndefined();
    // The draft is untouched (still draft, no change to its shape).
    expect(getSharedProposalEngine().getProposal(id).status).toBe("draft");
  });

  test("no AI provider configured → 503 graceful envelope, nothing materialized", async () => {
    // Real server, permission granted, but NO aiService → the default
    // resolveProvider returns null (ai?.configured !== true) and the route
    // degrades to 503 rather than calling an unconfigured provider (or 500).
    const app = buildApp({ aiService: undefined });
    const { id, actionName } = seedDraftProposal();

    const { status, json } = await postMaterialize(app, id);

    expect(status).toBe(503);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("MATERIALIZE.NOT_CONFIGURED");

    // The engine was never touched — no candidate source on the draft.
    const persisted = readChange(id, actionName);
    expect(persisted?.generatedSource).toBeUndefined();
    expect(getSharedProposalEngine().getProposal(id).status).toBe("draft");
  });
});
