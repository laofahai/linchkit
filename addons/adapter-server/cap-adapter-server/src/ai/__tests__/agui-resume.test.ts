/**
 * AG-UI HITL resume/execute-half tests (Spec 71 P2b) — the SECURITY CORE.
 *
 * Run A (propose) writes the server-authoritative interrupt store entry via
 * `buildProposeInterrupt` (exactly what the runner does on a propose run). Run B
 * (resume) is driven through `runAgUiResume` — the same handler the runner's
 * `input.resume` branch calls — against a REAL CommandLayer (InMemoryStore +
 * createActionExecutor + a permission middleware), so the §6 anti-TOCTOU
 * defenses are exercised end to end:
 *  - resolved + correct payload → the record actually exists, the permission
 *    slot ran, the store entry is evicted, provenance rides on `systemMeta`;
 *  - cancelled → no write, declined finish;
 *  - swapped action (∉ actionSet) → RUN_ERROR (throws), no write;
 *  - digest mismatch → RUN_ERROR, no write;
 *  - expired interrupt → RUN_ERROR, no write;
 *  - cross-user (authenticated-but-wrong) → RUN_ERROR, no write;
 *  - unauthenticated (no actor) → RUN_ERROR, fail-closed, never anonymous;
 *  - one-shot replay → RUN_ERROR (already consumed), single execution only;
 *  - approve-with-edits → executes the EDITED input;
 *  - a CommandLayer permission DENY → normal finish (error surfaced), no record.
 *
 * "Throws" is the resume handler's RUN_ERROR signal: the run endpoint maps a
 * runner throw to a RUN_ERROR frame (run-endpoint.ts). A `cancelled` resume is
 * NOT a throw — it returns and the endpoint emits a plain success finish.
 */

import { describe, expect, test } from "bun:test";
import {
  type AGUIEvent,
  createAgUiApp,
  EventType,
  InMemoryInterruptStore,
  type ResumeEntry,
} from "@linchkit/cap-adapter-ag-ui";
import type {
  ActionDefinition,
  Actor,
  AIService,
  CommandExecuteOptions,
  CommandLayer,
} from "@linchkit/core";
import { createActionExecutor, createCommandLayer, InMemoryStore } from "@linchkit/core/server";
import type { ServerOptions } from "../../server";
import { AgUiResumeRejectedError, RESUME_REJECT_CODES, runAgUiResume } from "../agui-resume";
import {
  buildProposeInterrupt,
  computeInputDigest,
  createAssistantAgUiRunner,
} from "../agui-runner";

// ── Actors ──────────────────────────────────────────────────

const ALICE: Actor = { type: "human", id: "alice", groups: ["admin"] };
const BOB: Actor = { type: "human", id: "bob", groups: ["admin"] };
/** A user WITHOUT the group create_product requires (permission DENY case). */
const VIEWER: Actor = { type: "human", id: "viewer", groups: ["viewer"] };

// ── Actions ─────────────────────────────────────────────────

const createProduct: ActionDefinition = {
  name: "create_product",
  entity: "product",
  label: "Create Product",
  input: {
    name: { type: "string", required: true, label: "Name" },
    price: { type: "number", label: "Price" },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => ctx.create("product", ctx.input),
};

/** A second product action — the server-offered SWAP alternative (§2.5). */
const updateProduct: ActionDefinition = {
  name: "update_product",
  entity: "product",
  label: "Update Product",
  input: {
    id: { type: "string", required: true, label: "ID" },
    price: { type: "number", label: "Price" },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const { id, ...rest } = ctx.input as { id: string; [k: string]: unknown };
    return ctx.update("product", id, rest);
  },
};

/** An action NOT in any interrupt's vetted set — the forged-swap target. */
const deleteProduct: ActionDefinition = {
  name: "delete_product",
  entity: "product",
  label: "Delete Product",
  input: { id: { type: "string", required: true, label: "ID" } },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const { id } = ctx.input as { id: string };
    return ctx.delete("product", id);
  },
};

// ── Test harness: real CommandLayer with a permission slot ──

interface Harness {
  store: InMemoryStore;
  commandLayer: CommandLayer;
  /** The last `execute` options seen (for §6.6 provenance + permission asserts). */
  lastExecute: () => CommandExecuteOptions | undefined;
  /** How many times execute() ran (single-execution assertions). */
  executeCount: () => number;
}

function buildHarness(): Harness {
  const store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });
  executor.registry.register(createProduct);
  executor.registry.register(updateProduct);
  executor.registry.register(deleteProduct);

  const inner = createCommandLayer({ executor });

  // A minimal permission slot to PROVE it runs unconditionally on the resume
  // path (§6.1). It denies any actor lacking the "admin" group — so VIEWER is
  // rejected by CommandLayer even after human approval (§6.4 execute-time).
  inner.use({
    name: "test-permission",
    slot: "permission",
    handler: async (ctx, next) => {
      const groups = ctx.actor.groups ?? [];
      if (!groups.includes("admin")) {
        throw new Error(`not allowed: actor "${ctx.actor.id}" lacks admin`);
      }
      await next();
    },
  });

  let last: CommandExecuteOptions | undefined;
  let count = 0;
  // Spy proxy: spread the real CommandLayer (picks up `use` / `executeBatch` /
  // `getMiddlewares`) and override only `execute` to record the options (for
  // provenance + permission asserts) before delegating — the permission slot
  // still runs through the real pipeline.
  const commandLayer: CommandLayer = {
    ...inner,
    execute: (options) => {
      last = options;
      count += 1;
      return inner.execute(options);
    },
  };

  return {
    store,
    commandLayer,
    lastExecute: () => last,
    executeCount: () => count,
  };
}

// ── Run A: write the interrupt store entry (what the runner does) ──

interface ProposeResult {
  interruptId: string;
  inputDigest: string;
}

function propose(options: {
  store: InMemoryInterruptStore;
  proposerActor: Actor;
  tenant?: string;
  action?: string;
  input?: Record<string, unknown>;
  actionSet?: string[];
  approvalWindowMs?: number;
  now?: number;
  interruptId?: string;
}): ProposeResult {
  const action = options.action ?? "create_product";
  const input = options.input ?? { name: "Widget", price: 9.9 };
  const interruptId = options.interruptId ?? "int-1";
  buildProposeInterrupt({
    threadId: "t1",
    proposal: { action, input },
    proposerActor: options.proposerActor,
    tenant: options.tenant,
    store: options.store,
    interruptId,
    ...(options.approvalWindowMs !== undefined
      ? { approvalWindowMs: options.approvalWindowMs }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  // For action-set tests we expand the stored set beyond the primary action
  // (the runner would write [primary, ...alternatives]; P2a writes [primary],
  // so we overwrite to simulate a server that offered an alternative).
  if (options.actionSet) {
    const entry = options.store.get("t1", interruptId);
    if (entry) options.store.put({ ...entry, actionSet: options.actionSet });
  }
  return { interruptId, inputDigest: computeInputDigest(action, input) };
}

function resolvedResume(options: {
  interruptId: string;
  action: string;
  input: Record<string, unknown>;
  baseDigest: string;
}): ResumeEntry {
  return {
    interruptId: options.interruptId,
    status: "resolved",
    payload: {
      action: options.action,
      input: options.input,
      baseDigest: options.baseDigest,
    },
  };
}

/** Collect emitted events for a `runAgUiResume` call. */
function collector(): { emit: (e: AGUIEvent) => void; events: AGUIEvent[] } {
  const events: AGUIEvent[] = [];
  return { emit: (e) => events.push(e), events };
}

async function productCount(store: InMemoryStore): Promise<number> {
  return (await store.query("product", {})).length;
}

// ── Tests ───────────────────────────────────────────────────

describe("runAgUiResume — resolved (happy path)", () => {
  test("executes the approved Action, the record exists, store entry evicted, permission slot ran", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    const { emit, events } = collector();
    await runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: inputDigest,
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit,
    });

    // The record actually exists (the mutation really executed).
    const rows = await h.store.query("product", {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Widget", price: 9.9 });

    // The permission slot ran with the HUMAN actor (not the model/synthetic).
    expect(h.executeCount()).toBe(1);
    expect(h.lastExecute()?.actor?.id).toBe("alice");
    expect(h.lastExecute()?.command).toBe("create_product");

    // §6.6 — audit provenance rides on the TRUSTED systemMeta channel (`_hitl`),
    // not `meta` (which strips `_`-keys). It lands with the execution.
    const sys = h.lastExecute()?.systemMeta as Record<string, unknown> | undefined;
    const prov = sys?._hitl as Record<string, unknown> | undefined;
    expect(prov).toBeDefined();
    expect(prov?.proposedAction).toBe("create_product");
    expect(prov?.approvedAction).toBe("create_product");
    expect(prov?.interruptId).toBe(interruptId);
    expect(prov?.approvedBy).toEqual({ type: "human", id: "alice" });
    expect(prov?.editedVsProposedDelta).toEqual({}); // no edits

    // The store entry is evicted (one-shot spent).
    expect(interrupts.get("t1", interruptId)).toBeUndefined();

    // A success TOOL_CALL_RESULT was emitted, no RUN_ERROR.
    const toolResult = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
    expect(toolResult).toBeDefined();
  });
});

describe("runAgUiResume — cancelled (declined, no write)", () => {
  test("a cancelled resume writes nothing and does not throw", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    const { emit, events } = collector();
    await runAgUiResume({
      threadId: "t1",
      resume: [{ interruptId, status: "cancelled" }],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit,
    });

    expect(await productCount(h.store)).toBe(0); // NO write
    expect(h.executeCount()).toBe(0);
    expect(interrupts.get("t1", interruptId)).toBeUndefined(); // evicted
    // A declined text finish, no RUN_ERROR / TOOL_CALL_RESULT.
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(true);
    expect(events.some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(false);
  });

  test("a cancel that LOSES the claim (concurrent approve already claimed) does NOT evict the entry", async () => {
    // Regression for the unified-claim fix: a cancelled resume must take the
    // one-shot claim FIRST and only evict if it won. Here a concurrent approve
    // is simulated by claiming the entry directly (consumed=true, still present);
    // the cancel must then be rejected and must NOT evict the entry out from
    // under the in-flight approve.
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    // The "approve" wins the synchronous claim.
    expect(interrupts.claim("t1", interruptId)).toBe(true);

    const { emit } = collector();
    const run = runAgUiResume({
      threadId: "t1",
      resume: [{ interruptId, status: "cancelled" }],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit,
    });
    await expect(run).rejects.toBeInstanceOf(AgUiResumeRejectedError);
    await run.catch((e: AgUiResumeRejectedError) =>
      expect(e.code).toBe(RESUME_REJECT_CODES.unknownInterrupt),
    );

    // The entry the "approve" claimed is still present — the cancel did NOT
    // evict it (the pre-fix bug). No write happened either.
    expect(interrupts.get("t1", interruptId)).toBeDefined();
    expect(h.executeCount()).toBe(0);
  });
});

describe("runAgUiResume — §6.2 p2 swapped action", () => {
  test("an action outside the server-vetted set is rejected (RUN_ERROR), no write", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    const { emit } = collector();
    const run = runAgUiResume({
      threadId: "t1",
      // Forge a swap to delete_product (NOT in the actionSet [create_product]).
      resume: [
        resolvedResume({
          interruptId,
          action: "delete_product",
          input: { id: "x" },
          baseDigest: inputDigest,
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit,
    });

    await expect(run).rejects.toThrow(AgUiResumeRejectedError);
    await run.catch((e: AgUiResumeRejectedError) =>
      expect(e.code).toBe(RESUME_REJECT_CODES.actionNotInSet),
    );
    expect(await productCount(h.store)).toBe(0);
    expect(h.executeCount()).toBe(0);
    expect(interrupts.get("t1", interruptId)).toBeUndefined(); // hard reject evicts
  });

  test("a server-OFFERED alternative (in the set) IS allowed (legitimate swap)", async () => {
    const h = buildHarness();
    // Seed a product to update — same tenant as the resume (the update slot is
    // tenant-scoped, so the row must carry the resume's tenant to be found).
    const seeded = await h.store.create("product", {
      name: "Old",
      price: 1,
      tenant_id: "tenant-a",
    });
    const interrupts = new InMemoryInterruptStore();
    // Propose create_product but offer update_product as an alternative.
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
      actionSet: ["create_product", "update_product"],
    });

    await runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "update_product", // a server-offered alternative
          input: { id: seeded.id as string, price: 5 },
          baseDigest: inputDigest,
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit: collector().emit,
    });

    expect(h.executeCount()).toBe(1);
    expect(h.lastExecute()?.command).toBe("update_product");
    const updated = await h.store.get("product", seeded.id as string);
    expect(updated?.price).toBe(5);
  });
});

describe("runAgUiResume — §6.2 p3 digest mismatch", () => {
  test("a wrong baseDigest is rejected (RUN_ERROR), no write", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    const run = runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: "deadbeef-not-the-real-digest",
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit: collector().emit,
    });

    await expect(run).rejects.toMatchObject({ code: RESUME_REJECT_CODES.digestMismatch });
    expect(await productCount(h.store)).toBe(0);
    expect(h.executeCount()).toBe(0);
  });
});

describe("runAgUiResume — §5 expiry (server-authoritative)", () => {
  test("an expired interrupt is rejected (RUN_ERROR), no write — client clock not trusted", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    // Window opened at t=0 for 1000ms; resume arrives at t=2000 (past expiry).
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
      now: 0,
      approvalWindowMs: 1000,
    });

    const run = runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: inputDigest,
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit: collector().emit,
      now: 2000, // server clock — well past expiresAt
    });

    await expect(run).rejects.toMatchObject({ code: RESUME_REJECT_CODES.expired });
    expect(await productCount(h.store)).toBe(0);
    expect(h.executeCount()).toBe(0);
  });
});

describe("runAgUiResume — §6.2 p5 cross-user resume", () => {
  test("a DIFFERENT authenticated user is rejected (RUN_ERROR), no write", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    // Alice proposed; Bob tries to approve (authenticated, but not the proposer).
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    const run = runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: inputDigest,
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: BOB, tenant: "tenant-a" }, // real auth, wrong user
      emit: collector().emit,
    });

    await expect(run).rejects.toMatchObject({ code: RESUME_REJECT_CODES.crossUser });
    expect(await productCount(h.store)).toBe(0);
    expect(h.executeCount()).toBe(0);
  });

  test("the SAME id but a different tenant is rejected (tenant isolation)", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    const run = runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: inputDigest,
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-b" }, // wrong tenant
      emit: collector().emit,
    });

    await expect(run).rejects.toMatchObject({ code: RESUME_REJECT_CODES.crossUser });
    expect(h.executeCount()).toBe(0);
  });
});

describe("runAgUiResume — §6.3 fail-closed on unauthenticated", () => {
  test("no resolved actor is rejected (RUN_ERROR), never anonymous, no write", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    const run = runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: inputDigest,
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: undefined, tenant: undefined }, // fail-closed
      emit: collector().emit,
    });

    await expect(run).rejects.toMatchObject({ code: RESUME_REJECT_CODES.unauthenticated });
    expect(await productCount(h.store)).toBe(0);
    expect(h.executeCount()).toBe(0);
  });
});

describe("runAgUiResume — §6.2 p4 one-shot replay", () => {
  test("a second resume for the same interrupt is rejected (already consumed), single execution", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    const mk = () =>
      runAgUiResume({
        threadId: "t1",
        resume: [
          resolvedResume({
            interruptId,
            action: "create_product",
            input: { name: "Widget", price: 9.9 },
            baseDigest: inputDigest,
          }),
        ],
        store: interrupts,
        commandLayer: h.commandLayer,
        actorContext: { actor: ALICE, tenant: "tenant-a" },
        emit: collector().emit,
      });

    // First resume executes.
    await mk();
    expect(h.executeCount()).toBe(1);
    expect(await productCount(h.store)).toBe(1);

    // Replay — the one-shot is spent; rejected, no second execution.
    await expect(mk()).rejects.toMatchObject({ code: RESUME_REJECT_CODES.unknownInterrupt });
    expect(h.executeCount()).toBe(1); // still ONE
    expect(await productCount(h.store)).toBe(1); // still ONE record
  });

  test("a resume for a totally unknown interrupt id is rejected, no write", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const run = runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId: "never-existed",
          action: "create_product",
          input: { name: "Widget" },
          baseDigest: "x",
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit: collector().emit,
    });
    await expect(run).rejects.toMatchObject({ code: RESUME_REJECT_CODES.unknownInterrupt });
    expect(h.executeCount()).toBe(0);
  });
});

describe("runAgUiResume — approve-with-edits", () => {
  test("a different (edited) input with the same action + correct baseDigest executes the EDITED input", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    // Proposed price 9.9; baseDigest anchors the PROPOSED input.
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
      input: { name: "Widget", price: 9.9 },
    });

    await runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 8.9 }, // human edited 9.9 → 8.9
          baseDigest: inputDigest, // still echoes the PROPOSED digest
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit: collector().emit,
    });

    // The EDITED input executed (8.9, not the proposed 9.9).
    const rows = await h.store.query("product", {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.price).toBe(8.9);

    // §6.6 — the edited-vs-proposed delta is recorded in the provenance.
    const sys = h.lastExecute()?.systemMeta as Record<string, unknown> | undefined;
    const prov = sys?._hitl as Record<string, unknown> | undefined;
    expect(prov?.editedVsProposedDelta).toEqual({ price: { from: 9.9, to: 8.9 } });
    expect(prov?.proposedInput).toEqual({ name: "Widget", price: 9.9 });
    expect(prov?.approvedInput).toEqual({ name: "Widget", price: 8.9 });
  });
});

describe("runAgUiResume — §6.1/§6.4 permission slot is the authoritative gate", () => {
  test("approval does NOT bypass authz: a viewer's approved write is denied by CommandLayer (normal finish, no record)", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    // VIEWER proposed AND resumes — identity matches, so cross-user passes; the
    // permission slot must still DENY (approval is a SECOND gate, not a bypass).
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: VIEWER,
      tenant: "tenant-a",
    });

    const { emit, events } = collector();
    // The permission middleware THROWS for non-admins; the resume handler maps a
    // CommandLayer execute throw to a NORMAL finish (TOOL_CALL_RESULT error),
    // NOT a RUN_ERROR. So this resolves (no throw) but writes nothing.
    await runAgUiResume({
      threadId: "t1",
      resume: [
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: inputDigest,
        }),
      ],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: VIEWER, tenant: "tenant-a" },
      emit,
    });

    // The permission slot RAN (execute was attempted) but DENIED — no record.
    expect(h.executeCount()).toBe(1);
    expect(await productCount(h.store)).toBe(0);
    // The denial surfaced as a TOOL_CALL_RESULT error, not a RUN_ERROR.
    const toolResult = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as
      | (AGUIEvent & { content: string })
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult?.content).toContain("success");
    expect(JSON.parse(toolResult?.content ?? "{}").success).toBe(false);
    // The one-shot is spent even on a denied execute (re-propose to retry).
    expect(interrupts.get("t1", interruptId)).toBeUndefined();
  });
});

// ── End-to-end: the resume branch through the REAL runner + endpoint ──
//
// Drives `POST /api/agui/run` with `input.resume[]` via `app.handle` (in-process,
// port-free — never `app.listen`). The endpoint runs the runner's `input.resume`
// branch (no model turn), which re-resolves the actor fail-closed and calls
// `runAgUiResume`. Asserts the endpoint→runner→{RUN_FINISHED | RUN_ERROR} wiring:
// a hard rejection surfaces as RUN_ERROR; a clean resume finishes with a plain
// success frame and the record exists. The model is NEVER consulted on resume,
// so a minimal aiConfig (truthy) suffices — the branch returns before any model
// import.

const CONFIGURED_AI = { configured: true } as unknown as AIService;

function readSse(res: Response): Promise<Array<{ type: string } & Record<string, unknown>>> {
  return res.text().then((t) =>
    t
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .map((f) => JSON.parse(f.slice("data: ".length)) as { type: string }),
  );
}

function postRun(
  app: Awaited<ReturnType<typeof createAgUiApp>>,
  body: unknown,
  headers?: Record<string, string>,
) {
  return app.handle(
    new Request("http://local.test/api/agui/run", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** Build the run endpoint app wired to the REAL assistant runner + harness. */
async function buildResumeApp(options: {
  harness: Harness;
  interrupts: InMemoryInterruptStore;
  /** Resolve the run-B actor from the request (header `x-actor`); undefined → fail closed. */
  resolveActor?: (request: Request) => Actor | undefined;
}) {
  const serverOptions = {
    // aiConfig only needs to be truthy — the resume branch returns before any
    // model resolution. (cast: the resume path never touches its members.)
    aiConfig: {} as ServerOptions["aiConfig"],
    commandLayer: options.harness.commandLayer,
    resolveRequestActor: options.resolveActor ?? (() => ALICE),
    resolveRequestTenantId: () => "tenant-a",
  } as ServerOptions;

  const runner = createAssistantAgUiRunner(serverOptions, { interruptStore: options.interrupts });
  return createAgUiApp({ aiService: CONFIGURED_AI, runner });
}

const resumeRunInput = (resume: ResumeEntry[]) => ({
  threadId: "t1",
  runId: "rB",
  messages: [],
  tools: [],
  context: [],
  resume,
});

describe("POST /api/agui/run — resume branch (app.handle, real runner)", () => {
  test("a clean resolved resume finishes with a plain success frame and writes the record", async () => {
    const harness = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });
    const app = await buildResumeApp({ harness, interrupts, resolveActor: () => ALICE });

    const res = await postRun(
      app,
      resumeRunInput([
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: inputDigest,
        }),
      ]),
    );
    expect(res.status).toBe(200);
    const events = await readSse(res);

    // No RUN_ERROR; a plain success RUN_FINISHED (no interrupt outcome on resume).
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
    const finish = events.find((e) => e.type === "RUN_FINISHED");
    expect(finish).toBeDefined();
    expect("outcome" in (finish ?? {})).toBe(false);
    // A TOOL_CALL_RESULT carried the executed mutation.
    expect(events.some((e) => e.type === "TOOL_CALL_RESULT")).toBe(true);
    // The record actually exists; the store entry is evicted.
    expect(await productCount(harness.store)).toBe(1);
    expect(interrupts.get("t1", interruptId)).toBeUndefined();
  });

  test("a forged swapped-action resume surfaces RUN_ERROR through the endpoint, no write", async () => {
    const harness = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });
    const app = await buildResumeApp({ harness, interrupts, resolveActor: () => ALICE });

    const res = await postRun(
      app,
      resumeRunInput([
        resolvedResume({
          interruptId,
          action: "delete_product", // outside the vetted set
          input: { id: "x" },
          baseDigest: inputDigest,
        }),
      ]),
    );
    const events = await readSse(res);
    const err = events.find((e) => e.type === "RUN_ERROR");
    expect(err).toBeDefined();
    expect(String(err?.message)).toContain(RESUME_REJECT_CODES.actionNotInSet);
    expect(await productCount(harness.store)).toBe(0);
  });

  test("an unauthenticated resume (resolver returns undefined) fails closed → RUN_ERROR, no write", async () => {
    const harness = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });
    // The resolver returns undefined — the runner must NOT fall back to anonymous.
    const app = await buildResumeApp({ harness, interrupts, resolveActor: () => undefined });

    const res = await postRun(
      app,
      resumeRunInput([
        resolvedResume({
          interruptId,
          action: "create_product",
          input: { name: "Widget", price: 9.9 },
          baseDigest: inputDigest,
        }),
      ]),
    );
    const events = await readSse(res);
    const err = events.find((e) => e.type === "RUN_ERROR");
    expect(err).toBeDefined();
    expect(String(err?.message)).toContain(RESUME_REJECT_CODES.unauthenticated);
    expect(await productCount(harness.store)).toBe(0);
  });
});
