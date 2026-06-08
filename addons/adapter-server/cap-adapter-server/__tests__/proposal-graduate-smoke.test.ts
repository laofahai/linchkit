/**
 * Manual proposal GRADUATION → REAL server-assembly smoke test (Spec 55 §7.6/§7.7).
 *
 * Graduation is the single most safety-sensitive evolution endpoint: a happy run
 * writes an approved proposal's definition files to DISK (`ProposalFileWriter`)
 * and opens a GitHub PR (`ProposalGitCommitter`). This smoke proves that endpoint
 * is actually WIRED into the production server and FAILS CLOSED — WITHOUT ever
 * touching real git / `gh` / the filesystem.
 *
 * The sibling `proposal-graduate-api.test.ts` pins the route in isolation with
 * FAKE writer/committer stubs and covers the happy 200 path (PR opened). It does
 * NOT prove the route is mounted by the canonical `createServer(...)` factory,
 * nor that a REAL CommandLayer's permission slot gates it end-to-end. This smoke
 * fills exactly that gap: it dispatches `POST /api/proposals/:id/graduate`
 * through `createServer(...)` — the SAME assembly path `http-transport.ts` boots
 * in production — so a broken wiring (route not mounted, options not threaded,
 * permission slot bypassed) cannot pass.
 *
 * WHY this smoke is env-controlled and side-effect-free
 * ──────────────────────────────────────────────────────
 * `server.ts` mounts the route as
 *   `mountProposalGraduateAPI(app, { commandLayer, resolveRequestActor })`
 * — it threads ONLY commandLayer + resolveRequestActor; it does NOT inject the
 * writer/committer/config seams (those default to a real `ProposalFileWriter` +
 * real `ProposalGitCommitter`). So through `createServer` we cannot swap in fake
 * writers. Instead we rely on the route's THREE in-order gates to guarantee no
 * real disk/git side effect is ever reached:
 *   1. Permission slot (CommandLayer, `skipActionSlots:true`) — runs FIRST. With
 *      no permission middleware it fails closed (`PERMISSION.MIDDLEWARE_MISSING`)
 *      BEFORE config is probed or the engine is read.
 *   2. `resolveGraduationConfig(process.env)` — returns `null` unless
 *      `GITHUB_TOKEN`/`GH_TOKEN` is set, mapping to 503 `GRADUATION.NOT_CONFIGURED`.
 *      No writer/committer is constructed on this path.
 *   3. Approved-only guard inside `graduateProposal()` — a non-approved proposal
 *      is refused (422) BEFORE `writer.writeApprovedProposal()` is invoked, so
 *      NO file is written and NO git/`gh` runs even when a real writer/committer
 *      WAS constructed.
 * We deliberately stop at gate 3 with a DRAFT proposal: the happy 200 path (which
 * would require real git/`gh`) is intentionally NOT exercised here — it is owned
 * by the isolated `proposal-graduate-api.test.ts` with fake writer/committer.
 *
 * Env handling: tests 2 and 3 mutate `GITHUB_TOKEN`/`GH_TOKEN`. The shared
 * ProposalEngine and `process.env` are PROCESS-WIDE and survive across the
 * batched `bun test` run, so every env mutation is snapshotted and restored
 * EXACTLY (a key that was `undefined` before is `delete`d again, not set to the
 * string "undefined") inside a try/finally — so a thrown assertion still restores
 * env and nothing leaks into sibling suites.
 *
 * Dispatch is via `app.handle(new Request(...))` (in-process, port-free).
 * `app.listen(PORT)` is intentionally avoided — a bound socket per suite
 * SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type { CommandLayer, EntityDefinition, ProposalDefinition } from "@linchkit/core";
import {
  createActionExecutor,
  createCommandLayer,
  InMemoryExecutionLogger,
  InMemoryStore,
  type ProposalEngine,
} from "@linchkit/core/server";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { getSharedProposalEngine } from "../src/proposal-api";
import { createServer } from "../src/server";

const BASE = "http://local.test";

/** A FAKE GitHub token used ONLY to satisfy `resolveGraduationConfig` so the
 * not-configured gate is PASSED and the approved-only guard becomes the thing
 * under test. It is never used to authenticate against any real remote — the
 * draft proposal short-circuits before any `git`/`gh` subprocess runs. */
const FAKE_TOKEN = "smoke-fake-token-do-not-use";

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: { title: { type: "string", required: true, label: "Title" } },
};

/**
 * Register an allow-all permission middleware. The graduate route dispatches
 * with `skipActionSlots: true`, which is fail-closed: the CommandLayer rejects
 * it unless a permission middleware is present (the executor's default-allow
 * does NOT apply to non-action dispatches). In a real deployment cap-permission
 * provides this slot; here a minimal pass-through stands in for "the mutation is
 * authorized" so we can observe the config + approved-only gates run.
 */
function grantPermission(commandLayer: CommandLayer): void {
  commandLayer.use({
    name: "smoke_allow_graduate",
    slot: "permission",
    handler: async (_ctx, next) => {
      await next();
    },
  });
}

/** Build the REAL server via the canonical factory — the same assembly path
 * `http-transport.ts` boots in production. `withPermission:false` omits the
 * permission middleware so the `skipActionSlots` dispatch fails closed. */
function buildApp(opts: { withPermission?: boolean } = {}): {
  handle: (req: Request) => Promise<Response>;
} {
  const { withPermission = true } = opts;
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
  return createServer(graphqlSchema, {
    executor,
    commandLayer,
  });
}

/** The shared governed engine the route reads/persists into — seed drafts here. */
function sharedEngine(): ProposalEngine {
  return getSharedProposalEngine();
}

/**
 * Seed a GLOBALLY-UNIQUE draft proposal in the process-wide shared engine and
 * return it. The shared singleton survives across suites/tests in the batched
 * run and dedups by capability + change-set, so every fixture mints its own
 * capability + change name (counter + base-36 time suffix) to stay collision-
 * free. `createProposal` always lands the proposal in `status: "draft"` with a
 * freshly generated engine id.
 */
let uid = 0;
function seedDraft(): ProposalDefinition {
  uid += 1;
  const suffix = `${uid}-${Date.now().toString(36)}`;
  const capability = `cap-graduate-smoke-${suffix}`;
  const actionName = `smoke_graduate_action_${suffix}`;
  return sharedEngine().createProposal({
    title: `Graduate smoke proposal ${suffix}`,
    description: "Draft seeded by the graduation real-server smoke (never graduated).",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability,
    changeType: "minor",
    changes: [{ target: "action", operation: "create", name: actionName }],
  });
}

interface GraduateJson {
  success: boolean;
  data?: { prUrl?: string; branch?: string; commitSha?: string; committed?: boolean };
  error?: { code?: string; message?: string };
}

/** POST the graduate endpoint and read the body as text first: a 500 / assembly
 * crash can return non-JSON (HTML / plain text), and a bare `res.json()` would
 * throw an opaque SyntaxError that masks the real failure. Surface the raw body. */
async function postGraduate(
  app: { handle: (req: Request) => Promise<Response> },
  id: string,
): Promise<{ status: number; json: GraduateJson }> {
  const res = await app.handle(
    new Request(`${BASE}/api/proposals/${encodeURIComponent(id)}/graduate`, { method: "POST" }),
  );
  const body = await res.text();
  let json: GraduateJson;
  try {
    json = JSON.parse(body) as GraduateJson;
  } catch {
    throw new Error(`graduate returned non-JSON (status ${res.status}): ${body.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

// ── Env snapshot/restore (bulletproof against leaks into sibling suites) ──────

/**
 * Snapshot the given env keys, return a `restore()` that puts each key back to
 * EXACTLY its prior value — a key that was `undefined` before is `delete`d again
 * (never set to the literal string "undefined"). Call `restore()` from a
 * `finally` so a thrown assertion still restores env.
 */
function snapshotEnv(keys: readonly string[]): { restore: () => void } {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
  }
  return {
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

describe("POST /api/proposals/:id/graduate — real createServer smoke", () => {
  test("permission enforced: no middleware → fail closed (422), nothing reached", async () => {
    // No permission middleware on the real CommandLayer → the skipActionSlots
    // dispatch fails closed BEFORE the config probe, engine read, or any disk/git
    // side effect. Config/engine/writer are never reached because the permission
    // slot runs first. This proves the real assembly enforces the permission slot
    // end-to-end (the CommandLayer is real, not a stub).
    const draft = seedDraft();
    const app = buildApp({ withPermission: false });

    const { status, json } = await postGraduate(app, draft.id);

    // resolveStatusCode maps the unrecognized PERMISSION.MIDDLEWARE_MISSING code
    // to its 422 default (it is not 401/403, so not the AUTHZ_DENIED envelope);
    // the route forwards `errData.code` verbatim (`?? "GRADUATION.BLOCKED"`).
    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("PERMISSION.MIDDLEWARE_MISSING");
    // Defensive cross-check: the forwarded code is the permission-missing one,
    // never the route's BLOCKED fallback.
    expect(json.error?.code).toContain("PERMISSION");
    // The proposal stayed a draft — nothing graduated.
    expect(sharedEngine().getProposal(draft.id).status).toBe("draft");
  });

  test("graduation not configured → 503 graceful envelope, no writer/committer constructed", async () => {
    // Permission passes, but with NO GitHub token in the env
    // `resolveGraduationConfig` returns null → graceful 503. The writer/committer
    // are never constructed on this path. Snapshot + clear both token keys, then
    // restore exactly in finally so the mutation cannot leak into sibling suites.
    const draft = seedDraft();
    const app = buildApp({ withPermission: true });

    const env = snapshotEnv(["GITHUB_TOKEN", "GH_TOKEN"]);
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      const { status, json } = await postGraduate(app, draft.id);

      expect(status).toBe(503);
      expect(json.success).toBe(false);
      expect(json.error?.code).toBe("GRADUATION.NOT_CONFIGURED");
      // Still a draft — nothing graduated.
      expect(sharedEngine().getProposal(draft.id).status).toBe("draft");
    } finally {
      env.restore();
    }
  });

  test("approved-only guard: draft proposal → 422 not-approved, NOTHING written", async () => {
    // Permission passes AND a FAKE token makes `resolveGraduationConfig` return a
    // config — so we get PAST the not-configured gate and prove the approved-only
    // guard (not merely the config gate) is what stops a draft. A real
    // ProposalFileWriter + ProposalGitCommitter ARE constructed here, yet
    // `graduateProposal` short-circuits at the approved-only guard BEFORE
    // `writer.writeApprovedProposal` — so NO disk write and NO git/`gh` happen.
    //
    // We deliberately do NOT assert on prUrl/branch: the happy 200 path is
    // intentionally not exercised (it would require real git/`gh`). That path is
    // covered by the isolated `proposal-graduate-api.test.ts` with fakes.
    const draft = seedDraft();
    const app = buildApp({ withPermission: true });

    // Snapshot both keys, then DELETE GITHUB_TOKEN before setting the fake
    // GH_TOKEN. `resolveGraduationConfig` reads `env.GITHUB_TOKEN ?? env.GH_TOKEN`,
    // and `??` only falls through on null/undefined — NOT on an empty/whitespace
    // string. If the ambient env has a BLANK `GITHUB_TOKEN` (some CI runners set
    // it to ""), leaving it in place would shadow our fake `GH_TOKEN`, the token
    // would resolve to "" → trim length 0 → config null → this test would hit the
    // 503 not-configured path instead of the intended 422 approved-only path.
    // Deleting GITHUB_TOKEN makes the fake GH_TOKEN the resolved token regardless
    // of the caller's environment. Both keys are restored in `finally`.
    const env = snapshotEnv(["GITHUB_TOKEN", "GH_TOKEN"]);
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = FAKE_TOKEN;
    try {
      const { status, json } = await postGraduate(app, draft.id);

      expect(status).toBe(422);
      expect(json.success).toBe(false);
      // Route message: `Graduation requires an approved proposal — "<id>" is "draft".`
      expect(json.error?.message ?? "").toContain("approved");
      // Belt-and-suspenders: the proposal is still a draft — the approved-only
      // guard tripped, so no write/commit/PR path ran.
      expect(sharedEngine().getProposal(draft.id).status).toBe("draft");
    } finally {
      env.restore();
    }
  });
});
