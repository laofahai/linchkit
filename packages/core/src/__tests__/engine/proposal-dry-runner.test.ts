import { describe, expect, test } from "bun:test";
import {
  aggregateDryRunStatus,
  dryRunMaterializedChanges,
  MAX_INPUT_CASES,
} from "../../engine/proposal-dry-runner";
import type { DryRunOutcome, DryRunStatus, ExecutionDryRunProvider } from "../../types/dry-run";
import type { ProposalChange, ProposalDefinition } from "../../types/proposal";

/** A materialized, dry-runnable action change (mirrors the Phase 4/5 fixtures). */
function change(overrides: Partial<ProposalChange> = {}): ProposalChange {
  return {
    target: "action",
    operation: "create",
    name: "do_thing",
    materializationStatus: "materialized",
    generatedSource: "export const generated = { handler: async () => ({ ok: true }) };",
    ...overrides,
  };
}

function proposal(changes: ProposalChange[]): ProposalDefinition {
  return {
    id: "p1",
    title: "t",
    description: "d",
    author: { type: "ai", id: "a", name: "A" },
    capability: "demo",
    changeType: "minor",
    changes,
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** A fake provider returning a chosen status per (changeName,inputCaseId), recording jobs. */
function fakeProvider(
  statusFor: (job: { changeName: string; inputCaseId: string }) => DryRunStatus,
): {
  provider: ExecutionDryRunProvider;
  calls: Array<{ changeName: string; inputCaseId: string; source: string }>;
} {
  const calls: Array<{ changeName: string; inputCaseId: string; source: string }> = [];
  const provider: ExecutionDryRunProvider = {
    async dryRun(job) {
      calls.push({ changeName: job.changeName, inputCaseId: job.inputCaseId, source: job.source });
      return {
        changeName: job.changeName,
        target: job.target,
        status: statusFor({ changeName: job.changeName, inputCaseId: job.inputCaseId }),
        inputCaseId: job.inputCaseId,
      };
    },
  };
  return { provider, calls };
}

describe("aggregateDryRunStatus — worst-case across input cases", () => {
  const oc = (status: DryRunStatus): DryRunOutcome => ({
    changeName: "c",
    target: "action",
    status,
    inputCaseId: "i",
  });

  test("empty → skipped", () => {
    expect(aggregateDryRunStatus([])).toBe("skipped");
  });

  test("all passed → passed", () => {
    expect(aggregateDryRunStatus([oc("passed"), oc("passed")])).toBe("passed");
  });

  test("a content failure dominates passed", () => {
    expect(aggregateDryRunStatus([oc("passed"), oc("threw")])).toBe("threw");
  });

  test("infra_error outranks passed — incomplete verification is reported, not hidden", () => {
    // A case the sandbox could not run (infra_error) makes verification INCOMPLETE, so
    // the change must not be stamped a clean "passed"; the honest worst-case is the
    // infra warning. (Content failures still dominate infra_error — covered below.)
    expect(aggregateDryRunStatus([oc("infra_error"), oc("passed")])).toBe("infra_error");
  });

  test("a content failure still dominates infra_error", () => {
    expect(aggregateDryRunStatus([oc("infra_error"), oc("malformed_output")])).toBe(
      "malformed_output",
    );
  });

  test("the highest-severity content failure wins", () => {
    expect(aggregateDryRunStatus([oc("threw"), oc("forbidden_side_effect"), oc("oom")])).toBe(
      "forbidden_side_effect",
    );
  });

  test("malformed/non-string statuses are ignored, not crashed on", () => {
    const dirty = [
      oc("passed"),
      { changeName: "c", target: "action", inputCaseId: "i" } as unknown as DryRunOutcome,
      null as unknown as DryRunOutcome,
    ];
    expect(aggregateDryRunStatus(dirty)).toBe("passed");
  });
});

describe("dryRunMaterializedChanges — stamps the durable signal", () => {
  test("stamps dryRunStatus + dryRunOutcomes on a materialized change", async () => {
    const p = proposal([change()]);
    const { provider, calls } = fakeProvider(() => "passed");
    const result = await dryRunMaterializedChanges({ proposal: p, provider });

    expect(result.ranChangeNames).toEqual(["do_thing"]);
    expect(result.skippedChangeNames).toEqual([]);
    expect(p.changes[0]?.dryRunStatus).toBe("passed");
    expect(p.changes[0]?.dryRunOutcomes?.length).toBe(1);
    // Default is a single synthetic empty-input case.
    expect(calls).toEqual([
      {
        changeName: "do_thing",
        inputCaseId: "synthetic-0",
        source: change().generatedSource ?? "",
      },
    ]);
  });

  test("skips changes that did not materialize — never calls the provider for them", async () => {
    const p = proposal([
      change({ name: "no_status", materializationStatus: undefined, generatedSource: undefined }),
      change({ name: "failed", materializationStatus: "failed", generatedSource: undefined }),
      change({ name: "no_source", generatedSource: undefined }),
      change({ name: "declarative", target: "rule", generatedSource: undefined }),
    ]);
    const { provider, calls } = fakeProvider(() => "passed");
    const result = await dryRunMaterializedChanges({ proposal: p, provider });

    expect(result.ranChangeNames).toEqual([]);
    expect(result.skippedChangeNames).toEqual(["no_status", "failed", "no_source", "declarative"]);
    expect(calls).toEqual([]);
    for (const c of p.changes) expect(c.dryRunStatus).toBeUndefined();
  });

  test("worst-case across multiple input cases is stamped", async () => {
    const p = proposal([change()]);
    const { provider, calls } = fakeProvider(({ inputCaseId }) =>
      inputCaseId === "bad" ? "threw" : "passed",
    );
    const result = await dryRunMaterializedChanges({
      proposal: p,
      provider,
      inputCasesFor: () => [
        { inputCaseId: "good", input: { qty: 1 } },
        { inputCaseId: "bad", input: { qty: -1 } },
      ],
    });

    expect(result.ranChangeNames).toEqual(["do_thing"]);
    expect(calls.length).toBe(2);
    expect(p.changes[0]?.dryRunOutcomes?.length).toBe(2);
    expect(p.changes[0]?.dryRunStatus).toBe("threw");
  });

  test("a provider that THROWS is contained as infra_error; the run continues", async () => {
    const p = proposal([change({ name: "boom" }), change({ name: "fine" })]);
    const provider: ExecutionDryRunProvider = {
      async dryRun(job) {
        if (job.changeName === "boom") throw new Error("sandbox blew up");
        return {
          changeName: job.changeName,
          target: job.target,
          status: "passed",
          inputCaseId: job.inputCaseId,
        };
      },
    };
    const result = await dryRunMaterializedChanges({ proposal: p, provider });

    expect(result.ranChangeNames).toEqual(["boom", "fine"]);
    expect(p.changes[0]?.dryRunStatus).toBe("infra_error");
    expect(p.changes[0]?.dryRunOutcomes?.[0]?.error).toContain("sandbox blew up");
    // The throw did not abort the proposal-wide run.
    expect(p.changes[1]?.dryRunStatus).toBe("passed");
  });

  test("a changeNames scope dry-runs only those changes; out-of-scope signal preserved", async () => {
    const p = proposal([
      change({ name: "in_scope" }),
      change({
        name: "out_of_scope",
        dryRunStatus: "passed",
        dryRunOutcomes: [
          { changeName: "out_of_scope", target: "action", status: "passed", inputCaseId: "prev" },
        ],
      }),
    ]);
    const { provider, calls } = fakeProvider(() => "threw");
    const result = await dryRunMaterializedChanges({
      proposal: p,
      provider,
      changeNames: ["in_scope"],
    });

    // Only the in-scope change is dry-run; the out-of-scope one is never touched.
    expect(calls.map((c) => c.changeName)).toEqual(["in_scope"]);
    expect(result.ranChangeNames).toEqual(["in_scope"]);
    expect(result.skippedChangeNames).toEqual(["out_of_scope"]);
    expect(p.changes[0]?.dryRunStatus).toBe("threw");
    // The preserved change keeps its PRIOR durable signal (not overwritten).
    expect(p.changes[1]?.dryRunStatus).toBe("passed");
    expect(p.changes[1]?.dryRunOutcomes?.[0]?.inputCaseId).toBe("prev");
  });

  test("more than MAX_INPUT_CASES cases are truncated and reported", async () => {
    const p = proposal([change()]);
    const { provider, calls } = fakeProvider(() => "passed");
    const tooMany = Array.from({ length: MAX_INPUT_CASES + 3 }, (_, i) => ({
      inputCaseId: `case-${i}`,
      input: {},
    }));
    const result = await dryRunMaterializedChanges({
      proposal: p,
      provider,
      inputCasesFor: () => tooMany,
    });

    expect(calls.length).toBe(MAX_INPUT_CASES);
    expect(result.truncatedChangeNames).toEqual(["do_thing"]);
    expect(p.changes[0]?.dryRunOutcomes?.length).toBe(MAX_INPUT_CASES);
  });

  test("forwards tenantId, limits, and metadata to the provider", async () => {
    const p = proposal([change()]);
    let seen: { tenantId?: string; limits: unknown; metadata: unknown } | undefined;
    const provider: ExecutionDryRunProvider = {
      async dryRun(job) {
        seen = { tenantId: job.tenantId, limits: job.limits, metadata: job.metadata };
        return {
          changeName: job.changeName,
          target: job.target,
          status: "passed",
          inputCaseId: job.inputCaseId,
        };
      },
    };
    await dryRunMaterializedChanges({
      proposal: p,
      provider,
      tenantId: "tenant-x",
      limits: { timeoutMs: 1234, memoryBytes: 5678 },
      inputCasesFor: () => [{ inputCaseId: "c0", input: {}, metadata: { trace: "abc" } }],
    });

    expect(seen?.tenantId).toBe("tenant-x");
    expect(seen?.limits).toEqual({ timeoutMs: 1234, memoryBytes: 5678 });
    expect(seen?.metadata).toEqual({ trace: "abc" });
  });
});
