/**
 * Manual proposal graduation — unit + endpoint tests.
 *
 * Covers the injectable orchestrator (`graduateProposal`) and the Elysia route
 * (`mountProposalGraduateAPI`). The file writer and git committer are ALWAYS
 * injected stubs — no real filesystem, `git`, or `gh` is touched. A spy asserts
 * the committer is only ever asked to OPEN a PR (commitAndOpenPR), never merge.
 *
 * Endpoint tests dispatch via `app.handle(new Request(...))` (in-process,
 * port-free). `app.listen(PORT)` is intentionally avoided — a bound socket per
 * suite SEGFAULTS the batched addons run.
 */

import { describe, expect, test } from "bun:test";
import type { CommandLayer, ProposalDefinition } from "@linchkit/core";
import type { ProposalGitCommitResult } from "@linchkit/core/server";
import { Elysia } from "elysia";
import {
  type GraduationConfig,
  type GraduationEngine,
  type GraduationFileWriter,
  type GraduationGitCommitter,
  graduateProposal,
  mountProposalGraduateAPI,
  resolveGraduationConfig,
} from "../src/proposal-graduate-api";

const BASE = "http://local.test";

// ── Fixtures ─────────────────────────────────────────────────

function makeProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const now = new Date();
  return {
    id: "prop-abc12345",
    title: "Add late-fee rule",
    description: "Adds a rule for late fees",
    author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
    capability: "cap-demo",
    changeType: "minor",
    changes: [{ target: "rule", operation: "create", name: "late_fee" }],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: ["late_fee"],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "approved",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ProposalDefinition;
}

const PR_RESULT: ProposalGitCommitResult = {
  branch: "proposal/abc12345-add-late-fee-rule",
  prUrl: "https://github.com/acme/repo/pull/42",
  commitSha: "deadbeefcafef00d",
};

/** Committer stub that records calls and EXPOSES NO merge method. */
function makeCommitterSpy(result: ProposalGitCommitResult = PR_RESULT): {
  committer: GraduationGitCommitter;
  calls: Array<{ proposalId: string; files: readonly string[] }>;
} {
  const calls: Array<{ proposalId: string; files: readonly string[] }> = [];
  const committer: GraduationGitCommitter = {
    async commitAndOpenPR(proposal, writtenFiles) {
      calls.push({ proposalId: proposal.id, files: writtenFiles });
      return result;
    },
  };
  return { committer, calls };
}

function makeWriterSpy(
  files: string[] = ["/repo/addons/demo/cap-demo/src/rules/late_fee.rule.ts"],
): {
  writer: GraduationFileWriter;
  calls: ProposalDefinition[];
} {
  const calls: ProposalDefinition[] = [];
  const writer: GraduationFileWriter = {
    async writeApprovedProposal(proposal) {
      calls.push(proposal);
      return files;
    },
  };
  return { writer, calls };
}

function makeEngine(
  proposal: ProposalDefinition | undefined,
  opts: { withCommit?: boolean; commitThrows?: boolean } = {},
): { engine: GraduationEngine; committedIds: string[] } {
  const committedIds: string[] = [];
  const engine: GraduationEngine = {
    getProposal(id) {
      if (!proposal || proposal.id !== id) throw new Error(`Proposal "${id}" not found`);
      return proposal;
    },
  };
  if (opts.withCommit !== false) {
    engine.commitProposal = ({ proposalId }) => {
      if (opts.commitThrows) throw new Error("commit bookkeeping failed");
      committedIds.push(proposalId);
      return undefined;
    };
  }
  return { engine, committedIds };
}

const CONFIG: GraduationConfig = { rootDir: "/repo" };

// ── graduateProposal (orchestrator) ──────────────────────────

describe("graduateProposal — approved-only guard", () => {
  test("non-approved proposal → not_approved; writer/committer NOT called", async () => {
    const proposal = makeProposal({ status: "draft" });
    const { engine } = makeEngine(proposal);
    const { writer, calls: writerCalls } = makeWriterSpy();
    const { committer, calls: committerCalls } = makeCommitterSpy();

    const outcome = await graduateProposal(proposal.id, { engine, writer, committer });

    expect(outcome.kind).toBe("not_approved");
    if (outcome.kind === "not_approved") expect(outcome.status).toBe("draft");
    expect(writerCalls).toHaveLength(0);
    expect(committerCalls).toHaveLength(0);
  });

  test("missing proposal → not_found; writer/committer NOT called", async () => {
    const { engine } = makeEngine(undefined);
    const { writer, calls: writerCalls } = makeWriterSpy();
    const { committer, calls: committerCalls } = makeCommitterSpy();

    const outcome = await graduateProposal("does-not-exist", { engine, writer, committer });

    expect(outcome.kind).toBe("not_found");
    expect(writerCalls).toHaveLength(0);
    expect(committerCalls).toHaveLength(0);
  });
});

describe("graduateProposal — approved happy path", () => {
  test("calls writeApprovedProposal then commitAndOpenPR; returns PR result", async () => {
    const proposal = makeProposal();
    const { engine, committedIds } = makeEngine(proposal);
    const { writer, calls: writerCalls } = makeWriterSpy(["/repo/a.ts", "/repo/b.ts"]);
    const { committer, calls: committerCalls } = makeCommitterSpy();

    const outcome = await graduateProposal(proposal.id, { engine, writer, committer });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result).toEqual(PR_RESULT);
      expect(outcome.committed).toBe(true);
    }
    // writer ran, then committer received the EXACT files the writer returned
    expect(writerCalls).toHaveLength(1);
    expect(writerCalls[0]?.id).toBe(proposal.id);
    expect(committerCalls).toHaveLength(1);
    expect(committerCalls[0]?.files).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    // graduation recorded (approved → committed)
    expect(committedIds).toEqual([proposal.id]);
  });

  test("committer is ONLY asked to open a PR — never merge", async () => {
    const proposal = makeProposal();
    const { engine } = makeEngine(proposal);
    const { writer } = makeWriterSpy();
    const { committer, calls } = makeCommitterSpy();

    // The committer contract exposes exactly one method: commitAndOpenPR.
    // There is no merge surface to call, and the only invocation is the PR open.
    expect(Object.keys(committer)).toEqual(["commitAndOpenPR"]);
    expect(committer).not.toHaveProperty("merge");
    expect(committer).not.toHaveProperty("mergePR");

    await graduateProposal(proposal.id, { engine, writer, committer });
    expect(calls).toHaveLength(1);
  });

  test("engine without commitProposal → ok with committed=false (status untouched)", async () => {
    const proposal = makeProposal();
    const { engine } = makeEngine(proposal, { withCommit: false });
    const { writer } = makeWriterSpy();
    const { committer } = makeCommitterSpy();

    const outcome = await graduateProposal(proposal.id, { engine, writer, committer });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.committed).toBe(false);
  });

  test("commitProposal throwing does NOT fail graduation (PR already open)", async () => {
    const proposal = makeProposal();
    const { engine } = makeEngine(proposal, { commitThrows: true });
    const { writer } = makeWriterSpy();
    const { committer } = makeCommitterSpy();

    const outcome = await graduateProposal(proposal.id, { engine, writer, committer });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.committed).toBe(false);
  });
});

describe("graduateProposal — failure surfaces as error", () => {
  test("writer throwing → error; committer NOT reached", async () => {
    const proposal = makeProposal();
    const { engine } = makeEngine(proposal);
    const failingWriter: GraduationFileWriter = {
      async writeApprovedProposal() {
        throw new Error("disk full");
      },
    };
    const { committer, calls } = makeCommitterSpy();

    const outcome = await graduateProposal(proposal.id, {
      engine,
      writer: failingWriter,
      committer,
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("disk full");
    expect(calls).toHaveLength(0);
  });

  test("committer throwing (e.g. gh failure) → error", async () => {
    const proposal = makeProposal();
    const { engine } = makeEngine(proposal);
    const { writer } = makeWriterSpy();
    const failingCommitter: GraduationGitCommitter = {
      async commitAndOpenPR() {
        throw new Error("gh pr create failed");
      },
    };
    const outcome = await graduateProposal(proposal.id, {
      engine,
      writer,
      committer: failingCommitter,
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.message).toContain("gh pr create failed");
  });
});

// ── resolveGraduationConfig (env sourcing) ───────────────────

describe("resolveGraduationConfig", () => {
  test("no GitHub token → null (graduation not configured)", () => {
    expect(resolveGraduationConfig({})).toBeNull();
    expect(resolveGraduationConfig({ GITHUB_TOKEN: "  " })).toBeNull();
  });

  test("GITHUB_TOKEN present → config with cwd rootDir default", () => {
    const config = resolveGraduationConfig({ GITHUB_TOKEN: "ghp_x" });
    expect(config).not.toBeNull();
    expect(config?.rootDir).toBe(process.cwd());
  });

  test("GH_TOKEN + overrides honoured", () => {
    const config = resolveGraduationConfig({
      GH_TOKEN: "ghp_y",
      PROPOSAL_GRADUATE_ROOT_DIR: "/srv/repo",
      PROPOSAL_GRADUATE_BASE_BRANCH: "develop",
      PROPOSAL_GRADUATE_REMOTE: "upstream",
    });
    expect(config).toEqual({
      rootDir: "/srv/repo",
      baseBranch: "develop",
      remote: "upstream",
    });
  });
});

// ── Endpoint: POST /api/proposals/:id/graduate ───────────────

interface GraduateJson {
  success: boolean;
  data?: { prUrl?: string; branch?: string; commitSha?: string; committed?: boolean };
  error?: { message?: string; code?: string };
}

/** A permissive command layer so endpoint tests exercise the graduation logic. */
const PASS_COMMAND_LAYER = {
  execute: async () => ({ success: true, data: { skipped: true } }),
} as unknown as CommandLayer;

function mountTestApp(opts: {
  proposal?: ProposalDefinition;
  config?: GraduationConfig | null;
  committer?: GraduationGitCommitter;
  writer?: GraduationFileWriter;
  commandLayer?: CommandLayer;
}): { app: Elysia; committerCalls: Array<{ proposalId: string; files: readonly string[] }> } {
  const { engine } = makeEngine(opts.proposal);
  const { committer, calls } =
    opts.committer === undefined
      ? makeCommitterSpy()
      : {
          committer: opts.committer,
          calls: [] as Array<{ proposalId: string; files: readonly string[] }>,
        };
  const { writer } = opts.writer === undefined ? makeWriterSpy() : { writer: opts.writer };
  const app = new Elysia();
  mountProposalGraduateAPI(app, {
    commandLayer: opts.commandLayer ?? PASS_COMMAND_LAYER,
    engine,
    resolveConfig: () => (opts.config === undefined ? CONFIG : opts.config),
    createWriter: () => writer,
    createCommitter: () => committer,
  });
  return { app, committerCalls: calls };
}

async function postGraduate(
  app: Elysia,
  id: string,
): Promise<{ status: number; json: GraduateJson }> {
  const res = await app.handle(
    new Request(`${BASE}/api/proposals/${id}/graduate`, { method: "POST" }),
  );
  return { status: res.status, json: (await res.json()) as GraduateJson };
}

describe("POST /api/proposals/:id/graduate", () => {
  test("approved → 200 with PR data; committer asked to open exactly one PR", async () => {
    const proposal = makeProposal();
    const { app, committerCalls } = mountTestApp({ proposal });
    const { status, json } = await postGraduate(app, proposal.id);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.prUrl).toBe(PR_RESULT.prUrl);
    expect(json.data?.branch).toBe(PR_RESULT.branch);
    expect(json.data?.commitSha).toBe(PR_RESULT.commitSha);
    expect(json.data?.committed).toBe(true);
    expect(committerCalls).toHaveLength(1);
  });

  test("unauthorized caller → 403 canonical AUTHZ_DENIED; nothing written/committed", async () => {
    const proposal = makeProposal();
    const denying = {
      execute: async () => ({ success: false, data: { error: "not allowed" } }),
    } as unknown as CommandLayer;
    const { app, committerCalls } = mountTestApp({ proposal, commandLayer: denying });
    const { status, json } = await postGraduate(app, proposal.id);
    expect(status).toBe(403);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("AUTHZ_DENIED");
    expect(committerCalls).toHaveLength(0);
  });

  test("command layer absent → 503 (cannot authorize); committer NOT called", async () => {
    const proposal = makeProposal();
    const { committer, calls } = makeCommitterSpy();
    // Mount WITHOUT a command layer — the permission slot cannot run, so the
    // endpoint must fail closed rather than authorize a high-impact mutation.
    const app = new Elysia();
    mountProposalGraduateAPI(app, {
      engine: makeEngine(proposal).engine,
      resolveConfig: () => CONFIG,
      createWriter: () => makeWriterSpy().writer,
      createCommitter: () => committer,
    });
    const { status, json } = await postGraduate(app, proposal.id);
    expect(status).toBe(503);
    expect(json.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("not approved → 422; committer NOT called", async () => {
    const proposal = makeProposal({ status: "validated" });
    const { app, committerCalls } = mountTestApp({ proposal });
    const { status, json } = await postGraduate(app, proposal.id);

    expect(status).toBe(422);
    expect(json.success).toBe(false);
    expect(json.error?.message).toContain("approved");
    expect(committerCalls).toHaveLength(0);
  });

  test("missing proposal → 404", async () => {
    const { app } = mountTestApp({ proposal: makeProposal() });
    const { status, json } = await postGraduate(app, "nope");
    expect(status).toBe(404);
    expect(json.success).toBe(false);
  });

  test("git not configured → 503 graceful envelope; no write/commit attempted", async () => {
    const proposal = makeProposal();
    const failWriter: GraduationFileWriter = {
      async writeApprovedProposal() {
        throw new Error("should not be called when unconfigured");
      },
    };
    const { app, committerCalls } = mountTestApp({ proposal, config: null, writer: failWriter });
    const { status, json } = await postGraduate(app, proposal.id);

    expect(status).toBe(503);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe("GRADUATION.NOT_CONFIGURED");
    expect(committerCalls).toHaveLength(0);
  });

  test("write/commit failure → 500", async () => {
    const proposal = makeProposal();
    const failingCommitter: GraduationGitCommitter = {
      async commitAndOpenPR() {
        throw new Error("push rejected");
      },
    };
    const { app } = mountTestApp({ proposal, committer: failingCommitter });
    const { status, json } = await postGraduate(app, proposal.id);

    expect(status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error?.message).toContain("push rejected");
  });
});
