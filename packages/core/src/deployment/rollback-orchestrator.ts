/**
 * DeployRollbackOrchestrator — Spec 12 §6 "Full rollback (old instance stopped)".
 *
 * When a quick rollback (Nginx upstream switch-back) is no longer possible
 * because the old instance has already been stopped, a full rollback is needed:
 *
 *   git revert <commitSha> → new branch → push → GitHub PR
 *
 * The resulting PR is marked with a "rollback" label so it can be reviewed
 * quickly and merged. Once merged the Webhook → Builder → Deployer pipeline
 * (Spec 12 §2, §3, §4) deploys the reverted code automatically.
 *
 * Migration down: coordinating the migration down step is an application-level
 * concern outside this engine's scope. The caller should invoke migration down
 * before or after opening the revert PR, depending on the migration strategy
 * (Spec 12 §5.2 and Spec 38).
 *
 * The default subprocess runners use Bun.spawn. Tests inject custom runners
 * so they never touch the real git/gh binaries.
 */

import type { Logger } from "../types/logger";

// ── Types ────────────────────────────────────────────────────────────────

export interface RollbackRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Async runner for the `git` binary. Args are passed verbatim, no shell. */
export type RollbackGitRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<RollbackRunResult>;

/** Async runner for the `gh` binary. Args are passed verbatim, no shell. */
export type RollbackGhRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<RollbackRunResult>;

export interface DeployRollbackOrchestratorOptions {
  /** Absolute path to the repository root. */
  repoDir: string;
  /** Base branch the rollback PR targets. Default: "main". */
  baseBranch?: string;
  /** Git remote name. Default: "origin". */
  remote?: string;
  /** Branch name prefix. Default: "rollback/". */
  branchPrefix?: string;
  /** Override the default PR title builder. */
  prTitle?: (commitSha: string, subject: string) => string;
  /** Override the default PR body builder. */
  prBody?: (commitSha: string, subject: string) => string;
  /** Injectable git runner for tests. Default: Bun.spawn. */
  gitRunner?: RollbackGitRunner;
  /** Injectable gh runner for tests. Default: Bun.spawn. */
  ghRunner?: RollbackGhRunner;
  /** Optional logger. */
  logger?: Logger;
  /** Injectable clock for tests — returns a UTC timestamp string (YYYYMMDD-HHmmss). */
  clock?: () => string;
}

export interface RollbackInput {
  /** The commit SHA to revert. Must be a valid 40-char or abbreviated SHA. */
  commitSha: string;
  /** Optional override for the PR title (replaces the auto-generated "[ROLLBACK] Revert …" title). */
  titleOverride?: string;
  /** Optional extra text appended to the PR body. */
  bodyNote?: string;
}

export interface RollbackResult {
  /** The branch created for the revert commit. */
  branch: string;
  /** The SHA of the new revert commit. */
  revertCommitSha: string;
  /** The URL of the opened GitHub PR. */
  prUrl: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH_PREFIX = "rollback/";
const SHORT_SHA_LENGTH = 8;
// Match owner/repo segments without slashes or whitespace.
const PR_URL_REGEX = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

// ── Helpers ──────────────────────────────────────────────────────────────

function shortSha(sha: string): string {
  return sha.length <= SHORT_SHA_LENGTH ? sha : sha.slice(0, SHORT_SHA_LENGTH);
}

/** YYYYMMDD-HHmmss in UTC — keeps branch names sortable and collision-free. */
function utcTimestamp(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return [
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`,
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`,
  ].join("-");
}

function buildBranchName(prefix: string, sha: string, clock: () => string = utcTimestamp): string {
  return `${prefix}${shortSha(sha)}-${clock()}`;
}

function defaultPrTitle(commitSha: string, subject: string): string {
  const short = shortSha(commitSha);
  return subject.trim().length > 0
    ? `[ROLLBACK] Revert ${short}: ${subject.trim()}`
    : `[ROLLBACK] Revert ${short}`;
}

function defaultPrBody(commitSha: string, subject: string): string {
  const lines: string[] = [
    "## Rollback",
    "",
    `This PR reverts commit \`${commitSha}\` via \`git revert\`.`,
    "",
    `**Reverted commit:** ${commitSha}`,
  ];
  if (subject.trim().length > 0) {
    lines.push(`**Subject:** ${subject.trim()}`);
  }
  lines.push(
    "",
    "## Steps to merge",
    "",
    "1. Review the diff — ensure the revert is complete and correct.",
    "2. Merge (fast-track is safe for pure reverts with no conflicts).",
    "3. The Webhook → Builder → Deployer pipeline deploys the reverted code automatically.",
    "4. If a migration was part of the reverted commit, run `migration down` before merging.",
    "",
    "🤖 Generated by LinchKit DeployRollbackOrchestrator (Spec 12 §6)",
  );
  return lines.join("\n");
}

function failStep(step: string, result: RollbackRunResult): never {
  throw new Error(
    `DeployRollbackOrchestrator: '${step}' failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}

function extractPrUrl(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const match = line.match(PR_URL_REGEX);
    if (match) return match[0];
  }
  return null;
}

// ── Default runners ──────────────────────────────────────────────────────

function makeDefaultRunner(bin: string): RollbackGitRunner {
  return async (args, options) => {
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  };
}

const defaultGitRunner: RollbackGitRunner = makeDefaultRunner("git");
const defaultGhRunner: RollbackGhRunner = makeDefaultRunner("gh");

// ── DeployRollbackOrchestrator ───────────────────────────────────────────

export class DeployRollbackOrchestrator {
  private readonly repoDir: string;
  private readonly baseBranch: string;
  private readonly remote: string;
  private readonly branchPrefix: string;
  private readonly buildPrTitle: (sha: string, subject: string) => string;
  private readonly buildPrBody: (sha: string, subject: string) => string;
  private readonly gitRunner: RollbackGitRunner;
  private readonly ghRunner: RollbackGhRunner;
  private readonly logger?: Logger;
  private readonly clock: () => string;

  constructor(options: DeployRollbackOrchestratorOptions) {
    this.repoDir = options.repoDir;
    this.baseBranch = options.baseBranch ?? DEFAULT_BASE_BRANCH;
    this.remote = options.remote ?? DEFAULT_REMOTE;
    this.branchPrefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    this.buildPrTitle = options.prTitle ?? defaultPrTitle;
    this.buildPrBody = options.prBody ?? defaultPrBody;
    this.gitRunner = options.gitRunner ?? defaultGitRunner;
    this.ghRunner = options.ghRunner ?? defaultGhRunner;
    this.logger = options.logger;
    this.clock = options.clock ?? utcTimestamp;
  }

  /**
   * Revert `input.commitSha`, push the revert to a new branch, and open a
   * GitHub PR marked for rollback review.
   *
   * Steps:
   *   1. Validate commitSha is non-empty.
   *   2. git fetch <remote> <baseBranch> (best-effort, warn on failure).
   *   3. Resolve the original commit subject via `git log -1 --format=%s`.
   *   4. Create a new branch off <remote>/<baseBranch>.
   *   5. git revert <commitSha> --no-edit, then git commit.
   *   6. git push -u <remote> <branch>.
   *   7. gh pr create with rollback title + body.
   *   8. Parse and return the PR URL.
   *
   * Throws on any hard failure. The caller should arrange cleanup (e.g.
   * delete the local branch) if desired.
   */
  async orchestrate(input: RollbackInput): Promise<RollbackResult> {
    const { commitSha, titleOverride, bodyNote } = input;

    if (!commitSha || commitSha.trim().length === 0) {
      throw new Error("DeployRollbackOrchestrator: commitSha must be non-empty");
    }

    const cwd = { cwd: this.repoDir };

    // ── Step 1: git fetch (best-effort) ──────────────────────────────────
    const fetchResult = await this.gitRunner(["fetch", this.remote, this.baseBranch], cwd);
    if (fetchResult.exitCode !== 0) {
      this.logger?.warn?.(
        `DeployRollbackOrchestrator: git fetch ${this.remote} ${this.baseBranch} failed (exit ${fetchResult.exitCode}): ${fetchResult.stderr.trim()} — continuing`,
      );
    }

    // ── Step 2: resolve commit subject ───────────────────────────────────
    let subject = "";
    const logResult = await this.gitRunner(["log", "-1", "--format=%s", commitSha], cwd);
    if (logResult.exitCode === 0) {
      subject = logResult.stdout.trim();
    } else {
      this.logger?.warn?.(
        `DeployRollbackOrchestrator: could not resolve subject for ${commitSha} — using empty subject`,
      );
    }

    // ── Step 3: create branch ─────────────────────────────────────────────
    const branch = buildBranchName(this.branchPrefix, commitSha, this.clock);
    const remoteRef = `${this.remote}/${this.baseBranch}`;

    const checkoutFromRemote = await this.gitRunner(["checkout", "-b", branch, remoteRef], cwd);
    if (checkoutFromRemote.exitCode !== 0) {
      const checkoutFromLocal = await this.gitRunner(
        ["checkout", "-b", branch, this.baseBranch],
        cwd,
      );
      if (checkoutFromLocal.exitCode !== 0) {
        failStep("checkout", checkoutFromLocal);
      }
    }

    // ── Step 4: git revert ────────────────────────────────────────────────
    const revertResult = await this.gitRunner(["revert", commitSha, "--no-edit"], cwd);
    if (revertResult.exitCode !== 0) {
      failStep("revert", revertResult);
    }

    // ── Step 5: capture revert commit SHA ─────────────────────────────────
    const headResult = await this.gitRunner(["rev-parse", "HEAD"], cwd);
    if (headResult.exitCode !== 0) {
      failStep("rev-parse HEAD", headResult);
    }
    const revertCommitSha = headResult.stdout.trim();

    // ── Step 6: push ──────────────────────────────────────────────────────
    const pushResult = await this.gitRunner(["push", "-u", this.remote, branch], cwd);
    if (pushResult.exitCode !== 0) {
      failStep("push", pushResult);
    }

    // ── Step 7: open PR ───────────────────────────────────────────────────
    const prTitle = titleOverride ?? this.buildPrTitle(commitSha, subject);
    let prBody = this.buildPrBody(commitSha, subject);
    if (bodyNote && bodyNote.trim().length > 0) {
      prBody = `${prBody}\n\n---\n\n${bodyNote.trim()}`;
    }

    const prResult = await this.ghRunner(
      [
        "pr",
        "create",
        "--base",
        this.baseBranch,
        "--head",
        branch,
        "--title",
        prTitle,
        "--body",
        prBody,
        "--label",
        "rollback",
      ],
      cwd,
    );
    if (prResult.exitCode !== 0) {
      // gh pr create may fail if the "rollback" label does not exist in the repo.
      // Retry without the label rather than aborting — the title already signals rollback.
      this.logger?.warn?.(
        `DeployRollbackOrchestrator: gh pr create with --label rollback failed (exit ${prResult.exitCode}): ${prResult.stderr.trim()} — retrying without label`,
      );
      const prRetry = await this.ghRunner(
        [
          "pr",
          "create",
          "--base",
          this.baseBranch,
          "--head",
          branch,
          "--title",
          prTitle,
          "--body",
          prBody,
        ],
        cwd,
      );
      if (prRetry.exitCode !== 0) {
        failStep("pr create", prRetry);
      }
      const prUrl = extractPrUrl(prRetry.stdout);
      if (!prUrl) {
        throw new Error(
          `DeployRollbackOrchestrator: could not parse PR URL from 'gh pr create' stdout: ${prRetry.stdout.trim()}`,
        );
      }
      this.logger?.info?.(`DeployRollbackOrchestrator: PR opened at ${prUrl} (branch ${branch})`);
      return { branch, revertCommitSha, prUrl };
    }

    const prUrl = extractPrUrl(prResult.stdout);
    if (!prUrl) {
      throw new Error(
        `DeployRollbackOrchestrator: could not parse PR URL from 'gh pr create' stdout: ${prResult.stdout.trim()}`,
      );
    }

    this.logger?.info?.(`DeployRollbackOrchestrator: PR opened at ${prUrl} (branch ${branch})`);

    return { branch, revertCommitSha, prUrl };
  }
}

export function createDeployRollbackOrchestrator(
  options: DeployRollbackOrchestratorOptions,
): DeployRollbackOrchestrator {
  return new DeployRollbackOrchestrator(options);
}
