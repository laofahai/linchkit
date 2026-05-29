/**
 * ProposalGitCommitter — Spec 55 §7.7 "Graduation: from disk to PR".
 *
 * Thin orchestrator that graduates the on-disk files produced by
 * `ProposalFileWriter` into a reviewable GitHub PR. The boundary is
 * intentionally narrow:
 *
 *   - Pre-conditions: `proposal.status === "approved"` and `writtenFiles`
 *     is non-empty (the files actually written by the upstream writer).
 *   - Side effects: a fresh local branch, a single commit on it, a push
 *     to the configured remote, and a `gh pr create` invocation.
 *   - Failure mode: throw loudly. We do NOT auto-merge, NOT auto-resolve
 *     conflicts, and NOT skip hooks (`--no-verify` is forbidden).
 *   - Composition: the caller decides when to invoke this — typically
 *     from `ProposalEngine.onApproved`, after `ProposalFileWriter` has
 *     resolved. We deliberately do NOT auto-wire into the engine so the
 *     project keeps the option of staging or batching PRs.
 *
 * The default subprocess runners use `Bun.spawn`. Tests inject custom
 * runners so they never touch the real `git`/`gh` binaries.
 */

import type { ProposalDefinition } from "../types/proposal";

// ── Types ───────────────────────────────────────────────────

export interface ProposalGitCommitterRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Async runner for the `git` binary. Args are passed verbatim, no shell. */
export type ProposalGitRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<ProposalGitCommitterRunResult>;

/** Async runner for the `gh` binary. Args are passed verbatim, no shell. */
export type ProposalGhRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<ProposalGitCommitterRunResult>;

export interface ProposalGitCommitterOptions {
  /** Absolute path to the repository root — used as cwd for every subprocess. */
  rootDir: string;
  /** Base branch the PR targets. Default: "main". */
  baseBranch?: string;
  /** Git remote name. Default: "origin". */
  remote?: string;
  /** Branch namespace prefix. Default: "proposal/". */
  branchPrefix?: string;
  /** Override the default branch namer. */
  branchName?: (proposal: ProposalDefinition) => string;
  /** Override the default commit message builder. */
  commitMessage?: (proposal: ProposalDefinition, writtenFiles: readonly string[]) => string;
  /** Override the default PR title. */
  prTitle?: (proposal: ProposalDefinition) => string;
  /** Override the default PR body. */
  prBody?: (proposal: ProposalDefinition, writtenFiles: readonly string[]) => string;
  /** Injectable for tests; default spawns real `git` via Bun.spawn. */
  gitRunner?: ProposalGitRunner;
  /** Injectable for tests; default spawns real `gh` via Bun.spawn. */
  ghRunner?: ProposalGhRunner;
  /** Structured logger. If provided, used only for non-fatal warnings. */
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

export interface ProposalGitCommitResult {
  branch: string;
  prUrl: string;
  commitSha: string;
}

// ── Constants ───────────────────────────────────────────────

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH_PREFIX = "proposal/";
const MAX_SUBJECT_LENGTH = 72;
const MAX_SLUG_LENGTH = 40;
const SHORT_ID_LENGTH = 8;
// Match owner/repo segments without slashes or whitespace so we never overrun
// path boundaries on lines that contain unrelated trailing text or extra URLs.
const PR_URL_REGEX = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

// ── Helpers (pure) ──────────────────────────────────────────

/** Read provenance from the loosely-typed sidecar attached by life-system. */
function readSourceInsights(proposal: ProposalDefinition): readonly string[] {
  // The InsightToProposal translator attaches `evidence` as a non-enumerable
  // sidecar (see life-system/insight-to-proposal.ts). The same record may
  // also carry an explicit `sourceInsights: string[]` field if a downstream
  // capability decided to lift the provenance into a first-class slot.
  const explicit = (proposal as { sourceInsights?: unknown }).sourceInsights;
  if (Array.isArray(explicit)) {
    return explicit.filter((id): id is string => typeof id === "string");
  }
  const evidence = (proposal as { evidence?: { context?: Record<string, unknown> } }).evidence;
  const insightId = evidence?.context?.insightId;
  if (typeof insightId === "string" && insightId.length > 0) {
    return [insightId];
  }
  return [];
}

/** Truncate a single-line subject to at most {@link MAX_SUBJECT_LENGTH} chars. */
function truncateSubject(subject: string): string {
  if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  // Reserve one slot for the ellipsis character. Using "…" (U+2026) keeps
  // the byte budget tight vs. "..." (3 chars) so we lose minimal title.
  return `${subject.slice(0, MAX_SUBJECT_LENGTH - 1)}…`;
}

/** Slugify a free-form title into a branch-safe segment. */
function slugify(title: string, maxLength = MAX_SLUG_LENGTH): string {
  const normalised = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalised.length === 0) return "";
  if (normalised.length <= maxLength) return normalised;
  // Trim any trailing dash created by the cap so we never emit `…-/`.
  return normalised.slice(0, maxLength).replace(/-+$/, "");
}

function shortId(proposalId: string): string {
  return proposalId.length <= SHORT_ID_LENGTH
    ? proposalId
    : proposalId.slice(proposalId.length - SHORT_ID_LENGTH);
}

function defaultBranchName(proposal: ProposalDefinition, prefix: string): string {
  const sid = shortId(proposal.id);
  const slug = slugify(proposal.title);
  return slug.length === 0 ? `${prefix}${sid}` : `${prefix}${sid}-${slug}`;
}

function defaultCommitSubject(proposal: ProposalDefinition): string {
  return truncateSubject(`feat(proposal): ${proposal.title}`);
}

function defaultCommitMessage(
  proposal: ProposalDefinition,
  _writtenFiles: readonly string[],
): string {
  const subject = defaultCommitSubject(proposal);
  const trailers: string[] = [`Proposal-ID: ${proposal.id}`];
  const insights = readSourceInsights(proposal);
  if (insights.length > 0) {
    trailers.push(`Source-Insights: ${insights.join(", ")}`);
  }
  const body = proposal.description?.trim();
  // Conventional Commits layout: subject, optional body, trailers — trailers
  // MUST come last for `git interpret-trailers` and GitHub PR parsing to pick
  // them up as metadata rather than free-form prose.
  const segments: string[] = [subject];
  if (body && body.length > 0) {
    segments.push("", body);
  }
  segments.push("", trailers.join("\n"));
  return segments.join("\n");
}

function defaultPrTitle(proposal: ProposalDefinition): string {
  return defaultCommitSubject(proposal);
}

/** Path → repo-relative for body rendering. Falls back to absolute on mismatch. */
function relativeToRoot(rootDir: string, absolutePath: string): string {
  const root = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;
  return absolutePath.startsWith(root) ? absolutePath.slice(root.length) : absolutePath;
}

function defaultPrBody(
  proposal: ProposalDefinition,
  writtenFiles: readonly string[],
  rootDir: string,
): string {
  const lines: string[] = [];
  lines.push("## Proposal");
  lines.push(`- ID: ${proposal.id}`);
  lines.push(`- Status: ${proposal.status}`);
  const insights = readSourceInsights(proposal);
  if (insights.length > 0) {
    lines.push(`- Source insights: ${insights.join(", ")}`);
  }
  lines.push("");
  lines.push("## Changes");
  if (proposal.changes.length === 0) {
    lines.push("- (none)");
  } else {
    for (const change of proposal.changes) {
      lines.push(`- ${change.target} / ${change.operation} / ${change.name}`);
    }
  }
  lines.push("");
  lines.push("## Files written");
  for (const file of writtenFiles) {
    lines.push(`- ${relativeToRoot(rootDir, file)}`);
  }
  const description = proposal.description?.trim();
  if (description && description.length > 0) {
    lines.push("");
    lines.push("## Description");
    lines.push(description);
  }
  lines.push("");
  lines.push("🤖 Generated by LinchKit Evolution Engine (Spec 55 §7.7)");
  return lines.join("\n");
}

/** Throw a uniformly-formatted error for a non-zero subprocess exit. */
function failStep(stepName: string, result: ProposalGitCommitterRunResult): never {
  throw new Error(`git/gh '${stepName}' failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
}

// ── Default runners (Bun.spawn) ─────────────────────────────

function makeDefaultRunner(bin: string): ProposalGitRunner {
  return async (args, options) => {
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain both streams concurrently to avoid the buffer-fill deadlock
    // that bites every "read stdout then stderr" implementation.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  };
}

const defaultGitRunner: ProposalGitRunner = makeDefaultRunner("git");
const defaultGhRunner: ProposalGhRunner = makeDefaultRunner("gh");

// ── ProposalGitCommitter ────────────────────────────────────

export class ProposalGitCommitter {
  private readonly rootDir: string;
  private readonly baseBranch: string;
  private readonly remote: string;
  private readonly branchPrefix: string;
  private readonly branchNamer: (proposal: ProposalDefinition) => string;
  private readonly commitMessageBuilder: (
    proposal: ProposalDefinition,
    writtenFiles: readonly string[],
  ) => string;
  private readonly prTitleBuilder: (proposal: ProposalDefinition) => string;
  private readonly prBodyBuilder: (
    proposal: ProposalDefinition,
    writtenFiles: readonly string[],
  ) => string;
  private readonly gitRunner: ProposalGitRunner;
  private readonly ghRunner: ProposalGhRunner;
  private readonly logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };

  constructor(options: ProposalGitCommitterOptions) {
    this.rootDir = options.rootDir;
    this.baseBranch = options.baseBranch ?? DEFAULT_BASE_BRANCH;
    this.remote = options.remote ?? DEFAULT_REMOTE;
    this.branchPrefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    this.branchNamer = options.branchName ?? ((p) => defaultBranchName(p, this.branchPrefix));
    this.commitMessageBuilder = options.commitMessage ?? defaultCommitMessage;
    this.prTitleBuilder = options.prTitle ?? defaultPrTitle;
    this.prBodyBuilder = options.prBody ?? ((p, files) => defaultPrBody(p, files, this.rootDir));
    this.gitRunner = options.gitRunner ?? defaultGitRunner;
    this.ghRunner = options.ghRunner ?? defaultGhRunner;
    this.logger = options.logger;
  }

  /**
   * Commit the given files to a new branch derived from the proposal,
   * push to remote, and open a GitHub PR.
   *
   * Throws on:
   *   - proposal.status !== "approved"
   *   - empty writtenFiles
   *   - any git/gh subprocess non-zero exit (except `git fetch`, which is
   *     best-effort and only warns)
   *   - branch already exists locally OR remotely
   */
  async commitAndOpenPR(
    proposal: ProposalDefinition,
    writtenFiles: readonly string[],
  ): Promise<ProposalGitCommitResult> {
    // ── Pre-conditions ──
    if (proposal.status !== "approved") {
      throw new Error(
        `ProposalGitCommitter requires status "approved" — got "${proposal.status}" for proposal "${proposal.id}"`,
      );
    }
    if (writtenFiles.length === 0) {
      throw new Error(
        `ProposalGitCommitter requires at least one written file for proposal "${proposal.id}"`,
      );
    }

    const branch = this.branchNamer(proposal);
    const cwdOpt = { cwd: this.rootDir };

    // ── Step 1: git fetch (best-effort) ──
    const fetchResult = await this.gitRunner(["fetch", this.remote, this.baseBranch], cwdOpt);
    if (fetchResult.exitCode !== 0) {
      this.logger?.warn?.(
        `ProposalGitCommitter: git fetch ${this.remote} ${this.baseBranch} failed (exit ${fetchResult.exitCode}): ${fetchResult.stderr.trim()} — continuing`,
      );
    }

    // ── Step 2: refuse if branch exists locally ──
    const localCheck = await this.gitRunner(["rev-parse", "--verify", branch], cwdOpt);
    if (localCheck.exitCode === 0) {
      throw new Error(
        `ProposalGitCommitter: branch already exists locally: "${branch}" (proposal "${proposal.id}")`,
      );
    }

    // ── Step 3: refuse if branch exists on remote ──
    const remoteCheck = await this.gitRunner(
      ["ls-remote", "--exit-code", "--heads", this.remote, branch],
      cwdOpt,
    );
    if (remoteCheck.exitCode === 0) {
      throw new Error(
        `ProposalGitCommitter: branch already exists on remote: "${this.remote}/${branch}" (proposal "${proposal.id}")`,
      );
    }

    // ── Step 4: create branch from <remote>/<base>, fallback to <base> ──
    const remoteRef = `${this.remote}/${this.baseBranch}`;
    const checkoutFromRemote = await this.gitRunner(["checkout", "-b", branch, remoteRef], cwdOpt);
    if (checkoutFromRemote.exitCode !== 0) {
      // Remote ref may be missing (offline, fresh clone w/o tracking, ...);
      // fall back to the local base branch before giving up.
      const checkoutFromLocal = await this.gitRunner(
        ["checkout", "-b", branch, this.baseBranch],
        cwdOpt,
      );
      if (checkoutFromLocal.exitCode !== 0) {
        failStep("checkout", checkoutFromLocal);
      }
    }

    // ── Step 5: stage files explicitly (no -A / no .) ──
    const addResult = await this.gitRunner(["add", "--", ...writtenFiles], cwdOpt);
    if (addResult.exitCode !== 0) {
      failStep("add", addResult);
    }

    // ── Step 6: commit ──
    const commitMessage = this.commitMessageBuilder(proposal, writtenFiles);
    const commitResult = await this.gitRunner(["commit", "-m", commitMessage], cwdOpt);
    if (commitResult.exitCode !== 0) {
      failStep("commit", commitResult);
    }

    // ── Step 7: capture commit SHA ──
    const headResult = await this.gitRunner(["rev-parse", "HEAD"], cwdOpt);
    if (headResult.exitCode !== 0) {
      failStep("rev-parse HEAD", headResult);
    }
    const commitSha = headResult.stdout.trim();

    // ── Step 8: push ──
    const pushResult = await this.gitRunner(["push", "-u", this.remote, branch], cwdOpt);
    if (pushResult.exitCode !== 0) {
      failStep("push", pushResult);
    }

    // ── Step 9: open PR via gh ──
    const prTitle = this.prTitleBuilder(proposal);
    const prBody = this.prBodyBuilder(proposal, writtenFiles);
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
      ],
      cwdOpt,
    );
    if (prResult.exitCode !== 0) {
      failStep("pr create", prResult);
    }

    const prUrl = extractPrUrl(prResult.stdout);
    if (!prUrl) {
      throw new Error(
        `ProposalGitCommitter: could not parse PR URL from 'gh pr create' stdout: ${prResult.stdout.trim()}`,
      );
    }

    return { branch, prUrl, commitSha };
  }
}

/** Extract the GitHub PR URL from `gh pr create` stdout (last matching line). */
function extractPrUrl(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  // Walk backwards so the URL on the final line wins, matching the gh CLI
  // convention where any preceding noise (warnings, status messages) is
  // irrelevant to the caller.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const match = line.match(PR_URL_REGEX);
    if (match) return match[0];
  }
  return null;
}

export function createProposalGitCommitter(
  options: ProposalGitCommitterOptions,
): ProposalGitCommitter {
  return new ProposalGitCommitter(options);
}
