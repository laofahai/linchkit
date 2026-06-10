/**
 * `strictExecutionDryRun` — e2e endpoint tests (Spec 70 §7, PR #530 follow-up).
 *
 * Exercises the FULL adapter-server submit path: `mountProposalAPI` threads the
 * flag into the `ValidationContext` used by the auto-submit inside
 * POST /api/proposals/:id/approve, and core validation Phase 5 reads each
 * change's DURABLE `dryRunStatus`/`dryRunOutcomes` (it never executes anything).
 *
 * Covered matrix:
 *   - failed dry-run (threw) + strict=true  → submit BLOCKED (422, Phase 5 error)
 *   - failed dry-run (threw) + strict=false/omitted → submit passes, warning only
 *   - infra_error + strict=true             → NEVER blocks (warning only)
 *   - no dryRunStatus + strict=true         → Phase 5 "skipped", submit unaffected
 *
 * Endpoint tests dispatch via `app.handle(new Request(...))` (in-process,
 * port-free). `app.listen(PORT)` is intentionally avoided — a bound socket per
 * suite SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type { ActionDefinition, DryRunOutcome, ProposalChange } from "@linchkit/core";
import { Elysia } from "elysia";
import { getSharedProposalEngine, mountProposalAPI } from "../src/proposal-api";

const BASE = "http://local.test";

// ── Response shapes (subset of what the endpoints return) ────

interface FindingJson {
  code: string;
  message: string;
  target?: string;
}

interface PhaseResultJson {
  phase: number;
  status: "passed" | "failed" | "skipped";
  errors: FindingJson[];
  warnings: FindingJson[];
}

interface ValidationResultJson {
  passed: boolean;
  phases: PhaseResultJson[];
}

interface ProposalJson {
  id: string;
  status: string;
  validationResult?: ValidationResultJson;
}

/** 200 envelope: `data` is the serialized proposal. */
interface ApproveSuccessJson {
  success: boolean;
  data?: ProposalJson;
}

/** 422 envelope: `data` is the persisted validation result itself. */
interface ApproveFailureJson {
  success: boolean;
  error?: { message?: string };
  data?: ValidationResultJson;
}

interface GetProposalJson {
  success: boolean;
  data?: ProposalJson;
}

// ── Fixtures ─────────────────────────────────────────────────

/**
 * A MATERIALIZABLE change (action create) that passes Phase 1 static checks
 * (entity + policy present; the unknown entity only warns). The dry-run fields
 * mirror core's validation-phase5 test fixtures exactly.
 */
function makeActionChange(name: string, overrides: Partial<ProposalChange> = {}): ProposalChange {
  const definition: ActionDefinition = {
    name,
    entity: "demo_order",
    label: `Run ${name}`,
    policy: { mode: "sync", transaction: false },
  };
  return { target: "action", operation: "create", name, definition, ...overrides };
}

/** A per-case outcome behind a `threw` aggregate — same shape as core's tests. */
function threwOutcome(changeName: string): DryRunOutcome {
  return {
    changeName,
    target: "action",
    status: "threw",
    error: "TypeError: cannot read 'id' of undefined",
    inputCaseId: "case-1",
  };
}

/** Create a draft proposal in the SHARED singleton engine the API serves. */
function createDraft(changes: ProposalChange[]): string {
  const proposal = getSharedProposalEngine().createProposal({
    title: "Add generated action",
    description: "Strict execution dry-run e2e fixture",
    author: { type: "ai", id: "test-suite", name: "Test Suite" },
    capability: "cap-demo",
    changeType: "minor",
    changes,
  });
  return proposal.id;
}

/** Mount a fresh app whose submit sites carry the given strict-flag wiring. */
function mountApp(options?: { strictExecutionDryRun?: boolean }): Elysia {
  const app = new Elysia();
  mountProposalAPI(app, options);
  return app;
}

async function postApprove(app: Elysia, id: string): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`${BASE}/api/proposals/${id}/approve`, { method: "POST" }),
  );
  return { status: res.status, body: await res.json() };
}

async function getProposal(app: Elysia, id: string): Promise<GetProposalJson> {
  const res = await app.handle(new Request(`${BASE}/api/proposals/${id}`));
  return (await res.json()) as GetProposalJson;
}

function phase5Of(result: ValidationResultJson | undefined): PhaseResultJson | undefined {
  return result?.phases.find((p) => p.phase === 5);
}

// ── Tests ────────────────────────────────────────────────────

describe("POST /api/proposals/:id/approve — strictExecutionDryRun", () => {
  test("failed dry-run + strict=true → submit BLOCKED with a Phase 5 error (422)", async () => {
    const change = makeActionChange("strict_blocked_action", {
      dryRunStatus: "threw",
      dryRunOutcomes: [threwOutcome("strict_blocked_action")],
    });
    const id = createDraft([change]);
    const app = mountApp({ strictExecutionDryRun: true });

    const { status, body } = await postApprove(app, id);
    const json = body as ApproveFailureJson;

    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error?.message).toBe("Proposal validation failed. Cannot approve.");

    // The 422 envelope carries the persisted validation result: Phase 5 failed
    // with a blocking EXECUTION_DRY_RUN_FAILED error (not a warning).
    expect(json.data?.passed).toBe(false);
    const phase5 = phase5Of(json.data);
    expect(phase5?.status).toBe("failed");
    expect(phase5?.errors).toHaveLength(1);
    expect(phase5?.errors[0]?.code).toBe("EXECUTION_DRY_RUN_FAILED");
    expect(phase5?.errors[0]?.target).toBe("strict_blocked_action");
    expect(phase5?.errors[0]?.message).toContain("threw");
    // The first outcome's error detail is surfaced to the reviewer.
    expect(phase5?.errors[0]?.message).toContain("TypeError: cannot read 'id' of undefined");
    expect(phase5?.warnings).toEqual([]);

    // The proposal was NOT approved — failed validation drops it back to draft.
    const refreshed = await getProposal(app, id);
    expect(refreshed.data?.status).toBe("draft");
  });

  test("failed dry-run + strict=false → submit passes with a Phase 5 warning only", async () => {
    const change = makeActionChange("warn_only_action", {
      dryRunStatus: "threw",
      dryRunOutcomes: [threwOutcome("warn_only_action")],
    });
    const id = createDraft([change]);
    const app = mountApp({ strictExecutionDryRun: false });

    const { status, body } = await postApprove(app, id);
    const json = body as ApproveSuccessJson;

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.status).toBe("approved");

    const result = json.data?.validationResult;
    expect(result?.passed).toBe(true);
    const phase5 = phase5Of(result);
    expect(phase5?.status).toBe("passed");
    expect(phase5?.errors).toEqual([]);
    expect(phase5?.warnings).toHaveLength(1);
    expect(phase5?.warnings[0]?.code).toBe("EXECUTION_DRY_RUN_FAILED");
    expect(phase5?.warnings[0]?.target).toBe("warn_only_action");
  });

  test("failed dry-run + flag omitted (default wiring) → warn-only, submit passes", async () => {
    const change = makeActionChange("default_warn_action", {
      dryRunStatus: "threw",
      dryRunOutcomes: [threwOutcome("default_warn_action")],
    });
    const id = createDraft([change]);
    // No options at all — the historical mountProposalAPI(app) call shape.
    const app = mountApp();

    const { status, body } = await postApprove(app, id);
    const json = body as ApproveSuccessJson;

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.status).toBe("approved");

    const phase5 = phase5Of(json.data?.validationResult);
    expect(phase5?.status).toBe("passed");
    expect(phase5?.errors).toEqual([]);
    expect(phase5?.warnings).toHaveLength(1);
    expect(phase5?.warnings[0]?.code).toBe("EXECUTION_DRY_RUN_FAILED");
  });

  test("infra_error + strict=true → NEVER blocks (warning only, submit passes)", async () => {
    const change = makeActionChange("flaky_sandbox_action", {
      dryRunStatus: "infra_error",
    });
    const id = createDraft([change]);
    const app = mountApp({ strictExecutionDryRun: true });

    const { status, body } = await postApprove(app, id);
    const json = body as ApproveSuccessJson;

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.status).toBe("approved");

    const result = json.data?.validationResult;
    expect(result?.passed).toBe(true);
    const phase5 = phase5Of(result);
    expect(phase5?.status).toBe("passed");
    expect(phase5?.errors).toEqual([]);
    expect(phase5?.warnings).toHaveLength(1);
    expect(phase5?.warnings[0]?.code).toBe("EXECUTION_DRY_RUN_INFRA");
    expect(phase5?.warnings[0]?.target).toBe("flaky_sandbox_action");
  });

  test("no dryRunStatus + strict=true → Phase 5 skipped, submit unaffected", async () => {
    const change = makeActionChange("never_dry_run_action");
    const id = createDraft([change]);
    const app = mountApp({ strictExecutionDryRun: true });

    const { status, body } = await postApprove(app, id);
    const json = body as ApproveSuccessJson;

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.status).toBe("approved");

    const result = json.data?.validationResult;
    expect(result?.passed).toBe(true);
    const phase5 = phase5Of(result);
    expect(phase5?.status).toBe("skipped");
    expect(phase5?.errors).toEqual([]);
    expect(phase5?.warnings).toEqual([]);
  });
});
