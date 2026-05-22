import { describe, expect, it } from "bun:test";
import {
  createDeployRollbackOrchestrator,
  DeployRollbackOrchestrator,
  type RollbackGhRunner,
  type RollbackGitRunner,
  type RollbackRunResult,
} from "../src/deployment/rollback-orchestrator";

const REPO_DIR = "/tmp/fake-repo";
const BASE_SHA = "abc123def4567890abcdef1234567890abcdef12";
const REVERT_SHA = "deadbeef1234567890deadbeef1234567890dead";
const FAKE_PR_URL = "https://github.com/owner/repo/pull/42";
const FIXED_CLOCK = () => "20260101-000000";
const FIXED_BRANCH = "rollback/abc123de-20260101-000000";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Helpers ───────────────────────────────────────────────────────────────

function ok(stdout = "", stderr = ""): RollbackRunResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): RollbackRunResult {
  return { stdout: "", stderr, exitCode };
}

type GitCallLog = { args: readonly string[]; cwd: string }[];
type GhCallLog = { args: readonly string[]; cwd: string }[];

function makeGitRunner(
  responses: Record<string, RollbackRunResult>,
  log?: GitCallLog,
): RollbackGitRunner {
  return async (args, options) => {
    log?.push({ args, cwd: options.cwd });
    const key = args.join(" ");
    const result = responses[key];
    if (result === undefined) throw new Error(`Unexpected git call: "${key}"`);
    return result;
  };
}

function makeGhRunner(
  responses: Record<string, RollbackRunResult>,
  log?: GhCallLog,
): RollbackGhRunner {
  return async (args, options) => {
    log?.push({ args, cwd: options.cwd });
    // Match on the first 6 args to avoid embedding the full PR body in keys.
    const key6 = args.slice(0, 6).join(" ");
    const result = responses[key6] ?? responses[args.join(" ")];
    if (result === undefined) throw new Error(`Unexpected gh call: "${key6}"`);
    return result;
  };
}

/** Standard happy-path git responses for BASE_SHA + FIXED_BRANCH. */
function happyGitResponses(): Record<string, RollbackRunResult> {
  return {
    "fetch origin main": ok(),
    [`log -1 --format=%s ${BASE_SHA}`]: ok("feat: add something cool"),
    [`checkout -b ${FIXED_BRANCH} origin/main`]: ok(),
    [`revert ${BASE_SHA} --no-edit`]: ok("Revert applied"),
    "rev-parse HEAD": ok(`${REVERT_SHA}\n`),
    [`push -u origin ${FIXED_BRANCH}`]: ok(),
  };
}

function happyGhKey(): string {
  return `pr create --base main --head ${FIXED_BRANCH}`;
}

/** Extract the value after `flag` from the first gh `pr create` call in the log. */
function pickGhArg(ghLog: GhCallLog, flag: string): string {
  const call = ghLog.find((c) => c.args[0] === "pr");
  if (!call) throw new Error("no gh pr call found in log");
  const idx = call.args.indexOf(flag);
  if (idx < 0 || idx + 1 >= call.args.length) throw new Error(`flag "${flag}" not in gh call`);
  return call.args[idx + 1] as string;
}

/** Return the nth element of an array or throw. */
function atIndex<T>(arr: T[], n: number, label: string): T {
  const v = arr[n];
  if (v === undefined) throw new Error(`${label}[${n}] is undefined`);
  return v;
}

// ── Constructor ───────────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — constructor", () => {
  it("applies defaults", () => {
    const orch = new DeployRollbackOrchestrator({ repoDir: REPO_DIR });
    expect(orch).toBeInstanceOf(DeployRollbackOrchestrator);
  });

  it("factory function creates instance", () => {
    const orch = createDeployRollbackOrchestrator({ repoDir: REPO_DIR });
    expect(orch).toBeInstanceOf(DeployRollbackOrchestrator);
  });
});

// ── Validation ────────────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — input validation", () => {
  it("throws when commitSha is empty", async () => {
    const orch = createDeployRollbackOrchestrator({ repoDir: REPO_DIR });
    await expect(orch.orchestrate({ commitSha: "" })).rejects.toThrow(
      "commitSha must be non-empty",
    );
  });

  it("throws when commitSha is whitespace only", async () => {
    const orch = createDeployRollbackOrchestrator({ repoDir: REPO_DIR });
    await expect(orch.orchestrate({ commitSha: "   " })).rejects.toThrow(
      "commitSha must be non-empty",
    );
  });

  it("throws when commitSha is not a valid hex SHA", async () => {
    const orch = createDeployRollbackOrchestrator({ repoDir: REPO_DIR });
    await expect(orch.orchestrate({ commitSha: "not-a-sha!" })).rejects.toThrow("valid hex SHA");
  });
});

// ── Happy path ────────────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — happy path", () => {
  it("returns branch, revertCommitSha, and prUrl on success", async () => {
    const gitRunner = makeGitRunner(happyGitResponses());
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) });

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });

    const result = await orch.orchestrate({ commitSha: BASE_SHA });
    expect(result.revertCommitSha).toBe(REVERT_SHA);
    expect(result.prUrl).toBe(FAKE_PR_URL);
    expect(result.branch).toBe(FIXED_BRANCH);
  });

  it("includes [ROLLBACK] and short SHA in default PR title", async () => {
    const ghLog: GhCallLog = [];
    const gitRunner = makeGitRunner(happyGitResponses());
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) }, ghLog);

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    await orch.orchestrate({ commitSha: BASE_SHA });

    const title = pickGhArg(ghLog, "--title");
    expect(title).toContain("[ROLLBACK]");
    expect(title).toContain("abc123de");
    expect(title).toContain("feat: add something cool");
  });

  it("uses titleOverride when provided", async () => {
    const ghLog: GhCallLog = [];
    const gitRunner = makeGitRunner(happyGitResponses());
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) }, ghLog);

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    await orch.orchestrate({ commitSha: BASE_SHA, titleOverride: "Emergency rollback" });

    expect(pickGhArg(ghLog, "--title")).toBe("Emergency rollback");
  });

  it("appends bodyNote to PR body", async () => {
    const ghLog: GhCallLog = [];
    const gitRunner = makeGitRunner(happyGitResponses());
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) }, ghLog);

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    await orch.orchestrate({
      commitSha: BASE_SHA,
      bodyNote: "Also run: bun run migration:down",
    });

    expect(pickGhArg(ghLog, "--body")).toContain("Also run: bun run migration:down");
  });

  it("uses custom prTitle and prBody builders", async () => {
    const ghLog: GhCallLog = [];
    const gitRunner = makeGitRunner(happyGitResponses());
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) }, ghLog);

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      prTitle: () => "custom title",
      prBody: () => "custom body",
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    await orch.orchestrate({ commitSha: BASE_SHA });

    expect(pickGhArg(ghLog, "--title")).toBe("custom title");
    expect(pickGhArg(ghLog, "--body")).toBe("custom body");
  });

  it("includes commit SHA in PR body", async () => {
    const ghLog: GhCallLog = [];
    const gitRunner = makeGitRunner(happyGitResponses());
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) }, ghLog);

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    await orch.orchestrate({ commitSha: BASE_SHA });

    const body = pickGhArg(ghLog, "--body");
    expect(body).toContain(BASE_SHA);
    expect(body).toContain("Spec 12 §6");
  });
});

// ── Checkout fallback ─────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — checkout fallback", () => {
  it("falls back to local base branch when remote ref checkout fails", async () => {
    const gitLog: GitCallLog = [];

    const gitRunner = makeGitRunner(
      {
        "fetch origin main": ok(),
        [`log -1 --format=%s ${BASE_SHA}`]: ok("some fix"),
        [`checkout -b ${FIXED_BRANCH} origin/main`]: fail("unknown revision", 128),
        [`checkout -b ${FIXED_BRANCH} main`]: ok(),
        [`revert ${BASE_SHA} --no-edit`]: ok(),
        "rev-parse HEAD": ok(`${REVERT_SHA}\n`),
        [`push -u origin ${FIXED_BRANCH}`]: ok(),
      },
      gitLog,
    );
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) });

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    const result = await orch.orchestrate({ commitSha: BASE_SHA });
    expect(result.prUrl).toBe(FAKE_PR_URL);

    const checkouts = gitLog.filter((c) => c.args[0] === "checkout");
    expect(checkouts).toHaveLength(2);
    expect(atIndex(checkouts, 1, "checkouts").args).toContain("main");
  });

  it("throws when both remote and local checkout fail", async () => {
    const gitRunner = makeGitRunner({
      "fetch origin main": ok(),
      [`log -1 --format=%s ${BASE_SHA}`]: ok("some fix"),
      [`checkout -b ${FIXED_BRANCH} origin/main`]: fail("unknown revision", 128),
      [`checkout -b ${FIXED_BRANCH} main`]: fail("ref not found", 128),
    });
    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner: makeGhRunner({}),
      logger: silentLogger,
    });
    await expect(orch.orchestrate({ commitSha: BASE_SHA })).rejects.toThrow("checkout");
  });
});

// ── git fetch failure (best-effort) ──────────────────────────────────────

describe("DeployRollbackOrchestrator — fetch failure (best-effort)", () => {
  it("continues when git fetch fails", async () => {
    const responses = {
      ...happyGitResponses(),
      "fetch origin main": fail("network error", 1),
    };
    const gitRunner = makeGitRunner(responses);
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) });

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    const result = await orch.orchestrate({ commitSha: BASE_SHA });
    expect(result.prUrl).toBe(FAKE_PR_URL);
  });
});

// ── git log failure ───────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — log failure", () => {
  it("uses empty subject when git log fails", async () => {
    const ghLog: GhCallLog = [];
    const responses = {
      ...happyGitResponses(),
      [`log -1 --format=%s ${BASE_SHA}`]: fail("bad object", 128),
    };
    const gitRunner = makeGitRunner(responses);
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok(`${FAKE_PR_URL}\n`) }, ghLog);

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    await orch.orchestrate({ commitSha: BASE_SHA });

    const title = pickGhArg(ghLog, "--title");
    expect(title).toContain("[ROLLBACK]");
    expect(title).toContain("abc123de");
  });
});

// ── revert failure ────────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — revert failure", () => {
  it("aborts in-progress revert and throws when git revert fails (conflict)", async () => {
    const gitLog: GitCallLog = [];
    const responses = {
      ...happyGitResponses(),
      [`revert ${BASE_SHA} --no-edit`]: fail("CONFLICT (content): Merge conflict", 1),
      "revert --abort": ok(),
    };
    const gitRunner = makeGitRunner(responses, gitLog);
    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner: makeGhRunner({}),
      logger: silentLogger,
    });
    await expect(orch.orchestrate({ commitSha: BASE_SHA })).rejects.toThrow("revert");
    expect(gitLog.some((c) => c.args[0] === "revert" && c.args[1] === "--abort")).toBe(true);
  });
});

// ── push failure ──────────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — push failure", () => {
  it("throws when git push fails", async () => {
    const responses = {
      ...happyGitResponses(),
      [`push -u origin ${FIXED_BRANCH}`]: fail("remote rejected", 1),
    };
    const gitRunner = makeGitRunner(responses);
    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner: makeGhRunner({}),
      logger: silentLogger,
    });
    await expect(orch.orchestrate({ commitSha: BASE_SHA })).rejects.toThrow("push");
  });
});

// ── PR label retry ────────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — label retry", () => {
  it("retries gh pr create without --label when label does not exist", async () => {
    const ghLog: GhCallLog = [];
    const gitRunner = makeGitRunner(happyGitResponses());

    let callCount = 0;
    const ghRunner: RollbackGhRunner = async (args, options) => {
      ghLog.push({ args, cwd: options.cwd });
      callCount++;
      if (callCount === 1) return fail("Label 'rollback' not found", 1);
      return ok(`${FAKE_PR_URL}\n`);
    };

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    const result = await orch.orchestrate({ commitSha: BASE_SHA });
    expect(result.prUrl).toBe(FAKE_PR_URL);
    expect(callCount).toBe(2);
    expect(atIndex(ghLog, 1, "ghLog").args).not.toContain("--label");
  });

  it("throws immediately when gh pr create fails with non-label error (no retry)", async () => {
    let callCount = 0;
    const gitRunner = makeGitRunner(happyGitResponses());
    const ghRunner: RollbackGhRunner = async () => {
      callCount++;
      return fail("network error", 1);
    };

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    await expect(orch.orchestrate({ commitSha: BASE_SHA })).rejects.toThrow("pr create");
    expect(callCount).toBe(1);
  });

  it("throws when PR URL cannot be parsed from gh output", async () => {
    const gitRunner = makeGitRunner(happyGitResponses());
    const ghRunner = makeGhRunner({ [happyGhKey()]: ok("no url here\n") });

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    await expect(orch.orchestrate({ commitSha: BASE_SHA })).rejects.toThrow("PR URL");
  });
});

// ── Custom options ────────────────────────────────────────────────────────

describe("DeployRollbackOrchestrator — custom options", () => {
  it("respects custom remote and baseBranch", async () => {
    const CUSTOM_BRANCH = "rollback/abc123de-20260101-000000";
    const gitRunner = makeGitRunner({
      "fetch upstream develop": ok(),
      [`log -1 --format=%s ${BASE_SHA}`]: ok("some fix"),
      [`checkout -b ${CUSTOM_BRANCH} upstream/develop`]: ok(),
      [`revert ${BASE_SHA} --no-edit`]: ok(),
      "rev-parse HEAD": ok(`${REVERT_SHA}\n`),
      [`push -u upstream ${CUSTOM_BRANCH}`]: ok(),
    });
    const ghRunner = makeGhRunner({
      [`pr create --base develop --head ${CUSTOM_BRANCH}`]: ok(`${FAKE_PR_URL}\n`),
    });

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      remote: "upstream",
      baseBranch: "develop",
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    const result = await orch.orchestrate({ commitSha: BASE_SHA });
    expect(result.prUrl).toBe(FAKE_PR_URL);
  });

  it("respects custom branchPrefix", async () => {
    const REVERT_BRANCH = "revert/abc123de-20260101-000000";
    const gitRunner = makeGitRunner({
      "fetch origin main": ok(),
      [`log -1 --format=%s ${BASE_SHA}`]: ok("some fix"),
      [`checkout -b ${REVERT_BRANCH} origin/main`]: ok(),
      [`revert ${BASE_SHA} --no-edit`]: ok(),
      "rev-parse HEAD": ok(`${REVERT_SHA}\n`),
      [`push -u origin ${REVERT_BRANCH}`]: ok(),
    });
    const ghRunner = makeGhRunner({
      [`pr create --base main --head ${REVERT_BRANCH}`]: ok(`${FAKE_PR_URL}\n`),
    });

    const orch = createDeployRollbackOrchestrator({
      repoDir: REPO_DIR,
      branchPrefix: "revert/",
      clock: FIXED_CLOCK,
      gitRunner,
      ghRunner,
      logger: silentLogger,
    });
    const result = await orch.orchestrate({ commitSha: BASE_SHA });
    expect(result.branch).toMatch(/^\/revert\//);
    expect(result.prUrl).toBe(FAKE_PR_URL);
  });
});
