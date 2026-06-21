/**
 * AG-UI HITL resume handler authz/replay unit tests (Spec 71 P2b).
 *
 * Drives `runAgUiResume` against a REAL CommandLayer, exercising the §6
 * anti-TOCTOU authz defenses: cross-user isolation (§6.2 p5), fail-closed on
 * unauthenticated (§6.3), one-shot replay prevention (§6.2 p4), approve-with-edits,
 * and the permission-slot gate (§6.1/§6.4). Split from agui-resume-handler.test.ts
 * to stay under the 500-line guideline (#607).
 *
 * See agui-resume-handler.test.ts for the core execution-path tests.
 * See agui-resume-endpoint.test.ts for the HTTP-layer integration tests.
 */

import { describe, expect, test } from "bun:test";
import type { AGUIEvent } from "@linchkit/cap-adapter-ag-ui";
import { EventType, InMemoryInterruptStore } from "@linchkit/cap-adapter-ag-ui";
import { RESUME_REJECT_CODES, runAgUiResume } from "../agui-resume";
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
