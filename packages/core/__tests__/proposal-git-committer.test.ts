/**
 * Tests for ProposalGitCommitter (Spec 55 §7.7 graduation to PR).
 *
 * All subprocess interaction is mocked via injected `gitRunner` / `ghRunner`
 * so the suite never touches real git or gh. We record every call's args and
 * return a deterministic response per call index — this keeps the assertions
 * obvious at the cost of some repetition.
 */

import { describe, expect, it } from "bun:test";
import {
  createProposalGitCommitter,
  type ProposalGhRunner,
  ProposalGitCommitter,
  type ProposalGitCommitterRunResult,
  type ProposalGitRunner,
} from "../src/engine/proposal-git-committer";
import type { ProposalChange, ProposalDefinition } from "../src/types/proposal";

// ── Fixtures ────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-05-19T12:00:00.000Z");

function makeRuleChange(name = "auto_approve_small_orders"): ProposalChange {
  return {
    target: "rule",
    operation: "create",
    name,
    definition: { name } as never,
  };
}

function makeApprovedProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  return {
    id: "proposal_abcd1234efgh5678",
    title: "Auto-approve small orders",
    description: "Generated from insight #42.",
    author: { type: "ai", id: "insight-translator", name: "Insight Translator" },
    capability: "cap-life-demo",
    changeType: "minor",
    changes: [makeRuleChange()],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: ["auto_approve_small_orders"],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "approved",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    approvedAt: FIXED_NOW,
    approvedBy: { type: "human", id: "admin-1" },
    ...overrides,
  };
}

const SAMPLE_FILES = ["/repo/addons/demo/cap-life-demo/src/rules/_p.rule.ts"] as const;

// ── Test helpers ────────────────────────────────────────────

interface RecordedCall {
  bin: "git" | "gh";
  args: readonly string[];
  cwd: string;
}

function ok(stdout = "", stderr = ""): ProposalGitCommitterRunResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(exitCode = 1, stderr = "boom", stdout = ""): ProposalGitCommitterRunResult {
  return { stdout, stderr, exitCode };
}

/**
 * Build a runner that returns the indexed response per call. The runner
 * records each invocation into `calls`. If the test exhausts the queue, the
 * runner throws so a missing stub is immediately visible.
 */
function makeQueueRunner(
  bin: "git" | "gh",
  responses: readonly ProposalGitCommitterRunResult[],
  calls: RecordedCall[],
): ProposalGitRunner | ProposalGhRunner {
  let i = 0;
  return async (args, options) => {
    calls.push({ bin, args, cwd: options.cwd });
    const r = responses[i];
    i += 1;
    if (!r) {
      throw new Error(`No stubbed ${bin} response for call #${i} (args: ${args.join(" ")})`);
    }
    return r;
  };
}

// Standard happy-path response sequence for git (9 calls — fetch through push).
function happyGitResponses(): ProposalGitCommitterRunResult[] {
  return [
    ok(), // 1: fetch
    fail(1, "fatal: needed a single revision"), // 2: rev-parse --verify branch (not exists → exit 1)
    fail(2, "no such ref"), // 3: ls-remote (not exists)
    ok(), // 4: checkout -b ... origin/main
    ok(), // 5: add
    ok(), // 6: commit
    ok("deadbeef\n"), // 7: rev-parse HEAD
    ok(), // 8: push
  ];
}

function happyGhResponses(): ProposalGitCommitterRunResult[] {
  return [ok("https://github.com/acme/repo/pull/42\n")];
}

// ── Tests ───────────────────────────────────────────────────

describe("ProposalGitCommitter.commitAndOpenPR — success path", () => {
  it("runs the full sequence and returns branch/prUrl/commitSha", async () => {
    const calls: RecordedCall[] = [];
    const proposal = makeApprovedProposal();
    const files = [
      "/repo/addons/demo/cap-life-demo/src/rules/a.rule.ts",
      "/repo/addons/demo/cap-life-demo/src/views/b.view.ts",
    ];

    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", happyGhResponses(), calls),
    });

    const result = await committer.commitAndOpenPR(proposal, files);

    // Expected branch: short-id (last 8 of id) + slug (capped at 40).
    expect(result.branch).toBe("proposal/efgh5678-auto-approve-small-orders");
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(result.commitSha).toBe("deadbeef");

    // Verify call sequence (8 git + 1 gh = 9 calls).
    expect(calls).toHaveLength(9);
    expect(calls[0]).toMatchObject({ bin: "git", args: ["fetch", "origin", "main"], cwd: "/repo" });
    expect(calls[1]).toMatchObject({
      bin: "git",
      args: ["rev-parse", "--verify", result.branch],
    });
    expect(calls[2]).toMatchObject({
      bin: "git",
      args: ["ls-remote", "--exit-code", "--heads", "origin", result.branch],
    });
    expect(calls[3]).toMatchObject({
      bin: "git",
      args: ["checkout", "-b", result.branch, "origin/main"],
    });
    // Step 5: add — files passed individually, prefixed by `--`.
    expect(calls[4].args).toEqual(["add", "--", files[0], files[1]]);
    // Step 6: commit — subject + body via -m.
    expect(calls[5].bin).toBe("git");
    expect(calls[5].args[0]).toBe("commit");
    expect(calls[5].args[1]).toBe("-m");
    const commitMsg = calls[5].args[2];
    expect(commitMsg).toContain("feat(proposal): Auto-approve small orders");
    expect(commitMsg).toContain(`Proposal-ID: ${proposal.id}`);
    expect(commitMsg).toContain("Generated from insight #42.");
    // --no-verify is forbidden.
    expect(calls[5].args).not.toContain("--no-verify");

    expect(calls[6]).toMatchObject({ bin: "git", args: ["rev-parse", "HEAD"] });
    expect(calls[7]).toMatchObject({
      bin: "git",
      args: ["push", "-u", "origin", result.branch],
    });
    // gh pr create
    expect(calls[8].bin).toBe("gh");
    expect(calls[8].args).toContain("pr");
    expect(calls[8].args).toContain("create");
    expect(calls[8].args).toContain("--base");
    expect(calls[8].args).toContain("main");
    expect(calls[8].args).toContain("--head");
    expect(calls[8].args).toContain(result.branch);
  });

  it("falls back to local base branch when origin/<base> checkout fails", async () => {
    const calls: RecordedCall[] = [];
    const gitResponses = happyGitResponses();
    // Replace step 4 (checkout from origin/main) with a failure, then add a
    // fallback success for checkout from local "main". Push down the rest.
    gitResponses.splice(
      3,
      1,
      fail(1, "error: pathspec 'origin/main' did not match"),
      ok(), // fallback checkout from local "main"
    );

    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", gitResponses, calls),
      ghRunner: makeQueueRunner("gh", happyGhResponses(), calls),
    });

    const result = await committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/42");
    // Confirm fallback was used.
    expect(calls[3].args).toEqual(["checkout", "-b", result.branch, "origin/main"]);
    expect(calls[4].args).toEqual(["checkout", "-b", result.branch, "main"]);
  });
});

describe("ProposalGitCommitter.commitAndOpenPR — pre-condition failures", () => {
  it("throws when proposal is not approved and never invokes runners", async () => {
    const calls: RecordedCall[] = [];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", [], calls),
      ghRunner: makeQueueRunner("gh", [], calls),
    });
    const draft = makeApprovedProposal({ status: "draft" });

    await expect(committer.commitAndOpenPR(draft, [...SAMPLE_FILES])).rejects.toThrow(
      /requires status "approved"/,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws when writtenFiles is empty and never invokes runners", async () => {
    const calls: RecordedCall[] = [];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", [], calls),
      ghRunner: makeQueueRunner("gh", [], calls),
    });

    await expect(committer.commitAndOpenPR(makeApprovedProposal(), [])).rejects.toThrow(
      /at least one written file/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("ProposalGitCommitter.commitAndOpenPR — branch collision", () => {
  it("throws when local branch already exists and stops before remote check", async () => {
    const calls: RecordedCall[] = [];
    const responses: ProposalGitCommitterRunResult[] = [
      ok(), // fetch
      ok(), // rev-parse --verify → 0 means branch exists
    ];

    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", responses, calls),
      ghRunner: makeQueueRunner("gh", [], calls),
    });

    await expect(
      committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]),
    ).rejects.toThrow(/branch already exists locally/);
    // Only fetch + rev-parse were called.
    expect(calls).toHaveLength(2);
  });

  it("throws when remote branch already exists", async () => {
    const calls: RecordedCall[] = [];
    const responses: ProposalGitCommitterRunResult[] = [
      ok(), // fetch
      fail(1, "fatal: needed a single revision"), // rev-parse → branch missing locally
      ok(), // ls-remote → 0 means branch present on remote
    ];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", responses, calls),
      ghRunner: makeQueueRunner("gh", [], calls),
    });

    await expect(
      committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]),
    ).rejects.toThrow(/branch already exists on remote/);
    expect(calls).toHaveLength(3);
  });
});

describe("ProposalGitCommitter.commitAndOpenPR — subprocess failures", () => {
  it("throws and includes stderr when git push fails", async () => {
    const calls: RecordedCall[] = [];
    const responses = happyGitResponses();
    responses[7] = fail(1, "remote: rejected"); // push fails

    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", responses, calls),
      ghRunner: makeQueueRunner("gh", [], calls),
    });

    await expect(
      committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]),
    ).rejects.toThrow(/push.*remote: rejected/s);
  });

  it("throws and includes stderr when gh pr create fails", async () => {
    const calls: RecordedCall[] = [];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", [fail(1, "gh: no auth")], calls),
    });

    await expect(
      committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]),
    ).rejects.toThrow(/pr create.*gh: no auth/s);
  });

  it("does NOT abort when git fetch fails; warns via logger and continues", async () => {
    const calls: RecordedCall[] = [];
    const warnings: string[] = [];
    const responses = happyGitResponses();
    responses[0] = fail(1, "fatal: unable to access"); // fetch fails

    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      logger: { warn: (m) => warnings.push(m) },
      gitRunner: makeQueueRunner("git", responses, calls),
      ghRunner: makeQueueRunner("gh", happyGhResponses(), calls),
    });

    const result = await committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("git fetch");
    expect(warnings[0]).toContain("fatal: unable to access");
    // Sequence kept going: 8 git + 1 gh.
    expect(calls).toHaveLength(9);
  });
});

describe("ProposalGitCommitter.commitAndOpenPR — overrides", () => {
  it("honors custom branchName, commitMessage, prTitle, prBody", async () => {
    const calls: RecordedCall[] = [];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      branchName: () => "custom/branch-x",
      commitMessage: () => "custom: subject",
      prTitle: () => "custom title",
      prBody: () => "custom body",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", happyGhResponses(), calls),
    });

    const result = await committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]);
    expect(result.branch).toBe("custom/branch-x");
    expect(calls[3].args).toEqual(["checkout", "-b", "custom/branch-x", "origin/main"]);
    expect(calls[5].args[2]).toBe("custom: subject");
    // PR title / body — find them positionally in the gh call.
    const ghCall = calls[calls.length - 1];
    expect(ghCall.args).toContain("--title");
    expect(ghCall.args[ghCall.args.indexOf("--title") + 1]).toBe("custom title");
    expect(ghCall.args[ghCall.args.indexOf("--body") + 1]).toBe("custom body");
  });
});

describe("ProposalGitCommitter — slug edge cases", () => {
  it("falls back to short-id when title produces an empty slug", async () => {
    const calls: RecordedCall[] = [];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", happyGhResponses(), calls),
    });
    const proposal = makeApprovedProposal({ title: "" });
    const result = await committer.commitAndOpenPR(proposal, [...SAMPLE_FILES]);
    expect(result.branch).toBe("proposal/efgh5678");
  });

  it("falls back to short-id when title is only special characters", async () => {
    const calls: RecordedCall[] = [];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", happyGhResponses(), calls),
    });
    const proposal = makeApprovedProposal({ title: "!!!@@@###" });
    const result = await committer.commitAndOpenPR(proposal, [...SAMPLE_FILES]);
    expect(result.branch).toBe("proposal/efgh5678");
  });

  it("caps slug at 40 chars when the title is long", async () => {
    const calls: RecordedCall[] = [];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", happyGhResponses(), calls),
    });
    const longTitle = "a".repeat(120);
    const proposal = makeApprovedProposal({ title: longTitle });
    const result = await committer.commitAndOpenPR(proposal, [...SAMPLE_FILES]);
    // After prefix + short-id + dash, slug portion must be exactly 40 chars.
    const slug = result.branch.replace(/^proposal\/efgh5678-/, "");
    expect(slug.length).toBe(40);
    expect(/^a+$/.test(slug)).toBe(true);
  });
});

describe("ProposalGitCommitter — PR URL parsing", () => {
  it("extracts the URL from a multi-line gh stdout", async () => {
    const calls: RecordedCall[] = [];
    const multiLine =
      "Creating pull request for proposal/foo-bar into main in acme/repo\n\nhttps://github.com/acme/repo/pull/123\n";
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", [ok(multiLine)], calls),
    });
    const result = await committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/123");
  });

  it("throws when stdout has no recognisable PR URL", async () => {
    const calls: RecordedCall[] = [];
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", [ok("no url here\n")], calls),
    });
    await expect(
      committer.commitAndOpenPR(makeApprovedProposal(), [...SAMPLE_FILES]),
    ).rejects.toThrow(/could not parse PR URL/);
  });
});

describe("ProposalGitCommitter — commit message truncation", () => {
  it("truncates the subject with an ellipsis when > 72 chars", async () => {
    const calls: RecordedCall[] = [];
    const longTitle = "x".repeat(200);
    const committer = new ProposalGitCommitter({
      rootDir: "/repo",
      gitRunner: makeQueueRunner("git", happyGitResponses(), calls),
      ghRunner: makeQueueRunner("gh", happyGhResponses(), calls),
    });

    await committer.commitAndOpenPR(makeApprovedProposal({ title: longTitle }), [...SAMPLE_FILES]);
    const commitMsg = calls[5].args[2];
    // First line is the subject — must be exactly 72 chars and end with the ellipsis.
    const subject = commitMsg.split("\n")[0];
    expect(subject.length).toBe(72);
    expect(subject.endsWith("…")).toBe(true);
  });
});

describe("createProposalGitCommitter factory", () => {
  it("returns a ProposalGitCommitter instance", () => {
    const c = createProposalGitCommitter({ rootDir: "/repo" });
    expect(c).toBeInstanceOf(ProposalGitCommitter);
  });
});
