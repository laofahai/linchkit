/**
 * Durable materialization quality signal — REAL server-assembly smoke (G5 Phase 4).
 *
 * The sibling `proposal-materialize-api.test.ts` pins the route in isolation with
 * an injected fake provider and a pass-everything gate. This smoke instead drives
 * `POST /api/proposals/:id/materialize` through the canonical `createServer(...)`
 * factory — the SAME assembly `http-transport.ts` boots in production — with:
 *   - a REAL `createCommandLayer({ executor })` + an allow-all permission slot
 *     (the materialize dispatch uses `skipActionSlots:true` → fails closed without
 *     one: `PERMISSION.MIDDLEWARE_MISSING`),
 *   - a REAL `createCodeGenerationProvider` built from an INJECTED fake `AIService`
 *     (`configured:true`) whose `complete()` returns syntactically-BROKEN source,
 *   - the REAL Phase-2 syntax gate (`createSyntaxQualityGate`) that the route mounts
 *     by default — so the gate genuinely FAILS the generated source.
 *
 * The core proof: after the (failing) materialize, a SECOND, separate
 * `GET /api/proposals/:id` request returns a change that DURABLY carries
 * `materializationStatus:"failed"` + a non-empty `materializationErrors` array,
 * and NO `generatedSource`. The signal survives past the transient materialize
 * response. SAFETY: the proposal stays `draft` (never auto-advanced).
 *
 * The route persists into the PROCESS-WIDE shared engine
 * (`getSharedProposalEngine()`), which survives across suites in the batched
 * runner, so every fixture is GLOBALLY UNIQUE (module counter + time suffix).
 *
 * Dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite SEGFAULTS
 * the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type {
  AICompletionOptions,
  AICompletionResult,
  AIService,
  CommandLayer,
  EntityDefinition,
  ProposalChange,
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

/** Syntactically-broken source so the REAL syntax gate fails every attempt. */
const BROKEN_SOURCE = "export const x = (((;";

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: { title: { type: "string", required: true, label: "Title" } },
};

/**
 * Globally-unique suffix so the process-wide shared engine never collides across
 * suites/tests in the batched runner.
 */
let uid = 0;
function uniqueSuffix(): string {
  uid += 1;
  return `${uid}-${Date.now().toString(36)}`;
}

/**
 * Allow-all permission middleware. The materialize route dispatches with
 * `skipActionSlots:true`, which is fail-closed: the CommandLayer rejects it unless
 * a permission slot is present. In a real deployment cap-permission provides this;
 * here a pass-through stands in for "the mutation is authorized".
 */
function grantMaterializePermission(commandLayer: CommandLayer): void {
  commandLayer.use({
    name: "smoke_allow_materialize",
    slot: "permission",
    handler: async (_ctx, next) => {
      await next();
    },
  });
}

/**
 * Fake AIService (`configured:true`) whose `complete()` returns broken source as
 * the completion `content`. The real `createCodeGenerationProvider` reads
 * `result.content`, so the route's provider yields BROKEN source and the real
 * syntax gate fails it.
 */
function makeBrokenAIService(): AIService {
  return {
    configured: true,
    defaultProvider: "fake",
    providerNames: ["fake"],
    async complete(_options: AICompletionOptions): Promise<AICompletionResult> {
      return {
        content: BROKEN_SOURCE,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: "fake",
        provider: "fake",
        duration: 0,
      };
    },
  };
}

/** Build the REAL server via the canonical factory with a broken AI provider. */
function buildApp(): { handle: (req: Request) => Promise<Response> } {
  const store = new InMemoryStore();
  const executor = createActionExecutor({
    dataProvider: store,
    executionLogger: new InMemoryExecutionLogger(),
  });
  const commandLayer = createCommandLayer({ executor });
  grantMaterializePermission(commandLayer);
  const graphqlSchema = buildGraphQLSchema([taskSchema], {
    executor,
    commandLayer,
    dataProvider: store,
  });
  return createServer(graphqlSchema, {
    executor,
    commandLayer,
    aiService: makeBrokenAIService(),
  });
}

// ── Response helpers ─────────────────────────────────────────

interface MaterializeJson {
  success: boolean;
  data?: {
    allMaterialized?: boolean;
    outcomes?: Array<{ changeName: string; status: string; errors?: string[] }>;
  };
  error?: { code?: string; message?: string };
}

interface ProposalGetJson {
  success: boolean;
  data?: {
    status?: string;
    changes?: ProposalChange[];
  };
  error?: { message?: string };
}

/** Read a response body as text first, then JSON-parse with a descriptive throw. */
async function readJson<T>(res: Response, label: string): Promise<T> {
  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${label} returned non-JSON (status ${res.status}): ${body.slice(0, 300)}`);
  }
}

async function postMaterialize(
  app: { handle: (req: Request) => Promise<Response> },
  id: string,
): Promise<{ status: number; json: MaterializeJson }> {
  const res = await app.handle(
    new Request(`${BASE}/api/proposals/${id}/materialize`, { method: "POST" }),
  );
  return { status: res.status, json: await readJson<MaterializeJson>(res, "materialize") };
}

async function getProposal(
  app: { handle: (req: Request) => Promise<Response> },
  id: string,
): Promise<{ status: number; json: ProposalGetJson }> {
  const res = await app.handle(new Request(`${BASE}/api/proposals/${id}`, { method: "GET" }));
  return { status: res.status, json: await readJson<ProposalGetJson>(res, "proposal GET") };
}

describe("POST /api/proposals/:id/materialize — durable failure signal (real createServer)", () => {
  test("failed materialization durably stamps the change; signal survives a separate GET", async () => {
    const app = buildApp();
    const sfx = uniqueSuffix();

    // Seed a DRAFT proposal with one materializable action/create change in the
    // SAME shared engine the route reads from.
    const draft = getSharedProposalEngine().createProposal({
      title: `Durable signal smoke ${sfx}`,
      description: "Materialization fails the syntax gate; the signal must persist.",
      author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
      capability: `cap-durable-smoke-${sfx}`,
      changeType: "minor",
      changes: [{ target: "action", operation: "create", name: `deduct_inventory_${sfx}` }],
    });
    expect(draft.status).toBe("draft");

    // ── 1. Materialize → 200, but generation FAILED the real syntax gate.
    const mat = await postMaterialize(app, draft.id);
    expect(mat.status).toBe(200);
    expect(mat.json.success).toBe(true);
    expect(mat.json.data?.allMaterialized).toBe(false);
    const outcome = mat.json.data?.outcomes?.[0];
    expect(outcome?.status).toBe("failed");
    expect((outcome?.errors ?? []).length).toBeGreaterThan(0);

    // ── 2. A SECOND, separate GET must show the DURABLE signal on the change.
    const got = await getProposal(app, draft.id);
    expect(got.status).toBe(200);
    expect(got.json.success).toBe(true);

    const change = got.json.data?.changes?.find((c) => c.name === `deduct_inventory_${sfx}`);
    expect(change).toBeDefined();
    // The core proof: the failure signal is DURABLE, not just in the transient
    // materialize response.
    expect(change?.materializationStatus).toBe("failed");
    expect(Array.isArray(change?.materializationErrors)).toBe(true);
    expect((change?.materializationErrors ?? []).length).toBeGreaterThan(0);
    // No candidate source survived the gate.
    expect(change?.generatedSource).toBeUndefined();

    // ── SAFETY: the proposal was never auto-advanced past draft.
    expect(got.json.data?.status).toBe("draft");
  });
});
