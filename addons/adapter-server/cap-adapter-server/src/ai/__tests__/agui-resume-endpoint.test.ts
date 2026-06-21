/**
 * AG-UI HITL resume endpoint integration tests (Spec 71 P2b).
 *
 * Drives `POST /api/agui/run` with `input.resume[]` via `app.handle`
 * (in-process, port-free — never `app.listen`). The endpoint runs the runner's
 * `input.resume` branch (no model turn), which re-resolves the actor fail-closed
 * and calls `runAgUiResume`. Asserts the endpoint→runner→{RUN_FINISHED | RUN_ERROR}
 * wiring. Split from agui-resume.test.ts to stay under the 500-line guideline (#607).
 *
 * See agui-resume-handler.test.ts for the handler-level unit tests.
 */

import { describe, expect, test } from "bun:test";
import type { ResumeEntry } from "@linchkit/cap-adapter-ag-ui";
import { createAgUiApp, InMemoryInterruptStore } from "@linchkit/cap-adapter-ag-ui";
import type { Actor, AIService } from "@linchkit/core";
import type { ServerOptions } from "../../server";
import { RESUME_REJECT_CODES } from "../agui-resume";
import { createAssistantAgUiRunner } from "../agui-runner";
import {
  ALICE,
  buildHarness,
  type Harness,
  productCount,
  propose,
  resolvedResume,
} from "./helpers/agui-resume-harness";

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
