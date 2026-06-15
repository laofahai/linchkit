/**
 * AG-UI HITL resume end-to-end tests — the resume branch through the REAL
 * runner + endpoint (Spec 71 P2b).
 *
 * Drives `POST /api/agui/run` with `input.resume[]` via `app.handle`
 * (in-process, port-free — never `app.listen`). The endpoint runs the runner's
 * `input.resume` branch (no model turn), which re-resolves the actor fail-closed
 * and calls `runAgUiResume`. Asserts the endpoint→runner→{RUN_FINISHED | RUN_ERROR}
 * wiring: a hard rejection surfaces as RUN_ERROR; a clean resume finishes with a
 * plain success frame and the record exists.
 *
 * The model is NEVER consulted on resume, so a minimal aiConfig (truthy) suffices
 * — the branch returns before any model import. Shared fixtures live in
 * helpers/agui-resume-harness.ts.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryInterruptStore } from "@linchkit/cap-adapter-ag-ui";
import { RESUME_REJECT_CODES } from "../agui-resume";
import {
  ALICE,
  buildHarness,
  buildResumeApp,
  postRun,
  productCount,
  propose,
  readSse,
  resolvedResume,
  resumeRunInput,
} from "./helpers/agui-resume-harness";

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
