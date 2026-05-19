/**
 * Deploy Builder — git pull → bun install → bun build pipeline.
 *
 * Implements the "Builder" component described in Spec 12 §3.
 * Pulls the latest code, installs deps only when lockfile changes,
 * then runs the configured build script.
 */

import type { Logger } from "../types/logger";

const stdoutLogger: Logger = {
  debug: (msg, ctx) => console.debug(`[DeployBuilder] ${msg}`, ctx ?? ""),
  info: (msg, ctx) => console.info(`[DeployBuilder] ${msg}`, ctx ?? ""),
  warn: (msg, ctx) => console.warn(`[DeployBuilder] ${msg}`, ctx ?? ""),
  error: (msg, ctx) => console.error(`[DeployBuilder] ${msg}`, ctx ?? ""),
};

// ── Types ────────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Inject a custom executor in tests to avoid real subprocesses. */
export type ProcessExecutor = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

export type BuildPhase = "idle" | "pulling" | "installing" | "building" | "done" | "failed";

export interface BuildResult {
  success: boolean;
  /** Phase at which the build stopped */
  phase: BuildPhase;
  /** Raw combined output from `git pull` */
  gitPullOutput: string;
  /** True when git reported "Already up to date" */
  upToDate: boolean;
  /** True when package.json or bun.lockb changed after pull */
  depsChanged: boolean;
  installOutput?: string;
  buildOutput?: string;
  durationMs: number;
  error?: string;
}

export interface BuildConfig {
  /** Absolute path to the repository root */
  repoDir: string;
  /** Git remote name (default: "origin") */
  remote?: string;
  /** Git branch to pull (default: "main") */
  branch?: string;
  /** Package script name to execute for building (default: "build") */
  buildScript?: string;
  /** Total timeout for the full build pipeline in ms (default: 300000) */
  timeoutMs?: number;
  logger?: Logger;
  /** Injected executor for unit tests */
  executor?: ProcessExecutor;
}

// ── DeployBuilder ────────────────────────────────────────────────────────

export class DeployBuilder {
  private readonly repoDir: string;
  private readonly remote: string;
  private readonly branch: string;
  private readonly buildScript: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly executor: ProcessExecutor;

  constructor(config: BuildConfig) {
    this.repoDir = config.repoDir;
    this.remote = config.remote ?? "origin";
    this.branch = config.branch ?? "main";
    this.buildScript = config.buildScript ?? "build";
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.logger = config.logger ?? stdoutLogger;
    this.executor = config.executor ?? defaultExecutor;
  }

  async build(): Promise<BuildResult> {
    const startMs = Date.now();
    const deadline = startMs + this.timeoutMs;

    const elapsed = () => Date.now() - startMs;
    const remaining = () => deadline - Date.now();

    this.logger.info("DeployBuilder: starting build pipeline", {
      repoDir: this.repoDir,
      remote: this.remote,
      branch: this.branch,
    });

    // ── Step 1: git pull ─────────────────────────────────────────────────
    if (remaining() <= 0) {
      return this.makeTimeoutResult({
        durationMs: elapsed(),
        phase: "pulling",
        gitPullOutput: "",
        upToDate: false,
        depsChanged: false,
      });
    }

    this.logger.info("DeployBuilder: git pull", { remote: this.remote, branch: this.branch });

    let pullResult: ExecResult;
    try {
      pullResult = await withTimeout(
        this.executor("git", ["pull", this.remote, this.branch], this.repoDir),
        remaining(),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        phase: "failed",
        gitPullOutput: "",
        upToDate: false,
        depsChanged: false,
        durationMs: elapsed(),
        error: `git pull error: ${msg}`,
      };
    }

    const gitPullOutput = pullResult.stdout + (pullResult.stderr ? `\n${pullResult.stderr}` : "");

    if (pullResult.exitCode !== 0) {
      this.logger.error("DeployBuilder: git pull failed", { exitCode: pullResult.exitCode });
      return {
        success: false,
        phase: "failed",
        gitPullOutput,
        upToDate: false,
        depsChanged: false,
        durationMs: elapsed(),
        error: `git pull failed (exit ${pullResult.exitCode}): ${gitPullOutput}`,
      };
    }

    const upToDate = pullResult.stdout.includes("Already up to date");
    this.logger.info("DeployBuilder: git pull complete", { upToDate });

    // ── Step 2: detect lockfile / manifest changes ────────────────────────
    // Use ORIG_HEAD (set by git after pull/merge) so multi-commit fast-forwards
    // are fully covered — HEAD~1 would only compare the latest commit.
    let depsChanged = false;
    if (!upToDate) {
      try {
        const diffResult = await withTimeout(
          this.executor("git", ["diff", "--name-only", "ORIG_HEAD", "HEAD"], this.repoDir),
          remaining(),
        );
        const changedFiles = diffResult.stdout.split("\n").filter(Boolean);
        depsChanged = changedFiles.some(
          (f) =>
            f === "package.json" ||
            f === "bun.lockb" ||
            f.endsWith("/package.json") ||
            f.endsWith("/bun.lockb"),
        );
        this.logger.info("DeployBuilder: deps change detection", { depsChanged, changedFiles });
      } catch {
        // Non-fatal: skip install on diff failure (e.g. initial commit, shallow clone)
        this.logger.warn("DeployBuilder: git diff failed, skipping install check");
      }
    }

    // ── Step 3: bun install (only when deps changed) ──────────────────────
    let installOutput: string | undefined;
    if (depsChanged) {
      if (remaining() <= 0) {
        return this.makeTimeoutResult({
          durationMs: elapsed(),
          phase: "installing",
          gitPullOutput,
          upToDate,
          depsChanged: true,
        });
      }

      this.logger.info("DeployBuilder: running bun install");

      let installResult: ExecResult;
      try {
        installResult = await withTimeout(
          this.executor("bun", ["install"], this.repoDir),
          remaining(),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          phase: "failed",
          gitPullOutput,
          upToDate,
          depsChanged,
          durationMs: elapsed(),
          error: `bun install error: ${msg}`,
        };
      }

      installOutput =
        installResult.stdout + (installResult.stderr ? `\n${installResult.stderr}` : "");

      if (installResult.exitCode !== 0) {
        this.logger.error("DeployBuilder: bun install failed", {
          exitCode: installResult.exitCode,
        });
        return {
          success: false,
          phase: "failed",
          gitPullOutput,
          upToDate,
          depsChanged,
          installOutput,
          durationMs: elapsed(),
          error: `bun install failed (exit ${installResult.exitCode}): ${installOutput}`,
        };
      }
    }

    // ── Step 4: bun run build ────────────────────────────────────────────
    if (remaining() <= 0) {
      return this.makeTimeoutResult({
        durationMs: elapsed(),
        phase: "building",
        gitPullOutput,
        upToDate,
        depsChanged,
      });
    }

    this.logger.info("DeployBuilder: running build script", { script: this.buildScript });

    let buildExecResult: ExecResult;
    try {
      buildExecResult = await withTimeout(
        this.executor("bun", ["run", this.buildScript], this.repoDir),
        remaining(),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        phase: "failed",
        gitPullOutput,
        upToDate,
        depsChanged,
        installOutput,
        durationMs: elapsed(),
        error: `bun run ${this.buildScript} error: ${msg}`,
      };
    }

    const buildOutput =
      buildExecResult.stdout + (buildExecResult.stderr ? `\n${buildExecResult.stderr}` : "");

    if (buildExecResult.exitCode !== 0) {
      this.logger.error("DeployBuilder: build failed", { exitCode: buildExecResult.exitCode });
      return {
        success: false,
        phase: "failed",
        gitPullOutput,
        upToDate,
        depsChanged,
        installOutput,
        buildOutput,
        durationMs: elapsed(),
        error: `bun run ${this.buildScript} failed (exit ${buildExecResult.exitCode}): ${buildOutput}`,
      };
    }

    this.logger.info("DeployBuilder: build pipeline complete", { durationMs: elapsed() });

    return {
      success: true,
      phase: "done",
      gitPullOutput,
      upToDate,
      depsChanged,
      installOutput,
      buildOutput,
      durationMs: elapsed(),
    };
  }

  private makeTimeoutResult(options: {
    durationMs: number;
    phase: BuildPhase;
    gitPullOutput: string;
    upToDate: boolean;
    depsChanged: boolean;
  }): BuildResult {
    const { durationMs, phase, gitPullOutput, upToDate, depsChanged } = options;
    this.logger.error("DeployBuilder: timed out", { phase, timeoutMs: this.timeoutMs });
    return {
      success: false,
      phase: "failed",
      gitPullOutput,
      upToDate,
      depsChanged,
      durationMs,
      error: `DeployBuilder timed out waiting to start "${phase}" after ${this.timeoutMs}ms`,
    };
  }
}

// ── Default executor using Bun.spawn ─────────────────────────────────────

const defaultExecutor: ProcessExecutor = async (cmd, args, cwd) => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain stdout and stderr concurrently to prevent deadlock when either
  // pipe's buffer fills while the other is being read sequentially.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

// ── Helpers ───────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`Operation timed out after ${ms}ms`)),
      Math.max(ms, 0),
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timerId));
}
