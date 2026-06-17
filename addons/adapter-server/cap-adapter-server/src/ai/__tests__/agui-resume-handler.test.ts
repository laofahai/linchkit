/**
 * AG-UI HITL resume handler unit tests (Spec 71 P2b) — the SECURITY CORE.
 *
 * Drives `runAgUiResume` directly against a REAL CommandLayer
 * (InMemoryStore + createActionExecutor + permission middleware), exercising
 * the §6 anti-TOCTOU defenses end to end. Split from agui-resume.test.ts
 * to stay under the 500-line guideline (#607).
 *
 * See agui-resume-endpoint.test.ts for the HTTP-layer integration tests.
 */

import { describe, expect, test } from "bun:test";
import type { AGUIEvent, ResumeEntry } from "@linchkit/cap-adapter-ag-ui";
import { EventType, InMemoryInterruptStore } from "@linchkit/cap-adapter-ag-ui";
import { AgUiResumeRejectedError, RESUME_REJECT_CODES, runAgUiResume } from "../agui-resume";
import {
  ALICE,
  BOB,
  buildHarness,
  collector,
  productCount,
  propose,
  resolvedResume,
  VIEWER,
} from "./helpers/agui-resume-harness";

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
          // baseDigest is the INTERRUPT anchor, NOT a per-action MAC: a swap to a
          // server-offered alternative correctly carries this interrupt's primary
          // inputDigest (it proves the client saw THIS proposal). The alternative
          // is authorized by actionSet membership (§6.2 p2) and its input by the
          // action's own schema inside CommandLayer — not by the digest.
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

  test("a malformed/unparseable expiresAt FAILS CLOSED (treated as expired), no write", async () => {
    // Date.parse("not-a-date") === NaN, and `now >= NaN` is false — without the
    // NaN guard a corrupt window would SILENTLY pass the expiry gate.
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });
    const corrupt = interrupts.get("t1", interruptId);
    if (corrupt) interrupts.put({ ...corrupt, expiresAt: "not-a-date" });

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
    });

    await expect(run).rejects.toMatchObject({ code: RESUME_REJECT_CODES.expired });
    expect(h.executeCount()).toBe(0);
  });
});

describe("runAgUiResume — unsupported status (only resolved may execute)", () => {
  test("a status that is neither resolved nor cancelled is rejected before the execute path", async () => {
    const h = buildHarness();
    const interrupts = new InMemoryInterruptStore();
    const { interruptId, inputDigest } = propose({
      store: interrupts,
      proposerActor: ALICE,
      tenant: "tenant-a",
    });

    // A malformed status carrying an otherwise-valid payload must NOT fall
    // through and execute (it would weaken the approval gate).
    const forged = {
      interruptId,
      status: "approved-ish",
      payload: {
        action: "create_product",
        input: { name: "Widget", price: 9.9 },
        baseDigest: inputDigest,
      },
    } as unknown as ResumeEntry;

    const run = runAgUiResume({
      threadId: "t1",
      resume: [forged],
      store: interrupts,
      commandLayer: h.commandLayer,
      actorContext: { actor: ALICE, tenant: "tenant-a" },
      emit: collector().emit,
    });

    await expect(run).rejects.toMatchObject({ code: RESUME_REJECT_CODES.malformedPayload });
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
