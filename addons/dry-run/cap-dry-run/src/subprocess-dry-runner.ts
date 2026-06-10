/**
 * Hardened Bun-subprocess execution dry-run runner — Spec 70 P3.
 *
 * Implements the core `ExecutionDryRunProvider` seam (Spec 70 P2) by running ONE
 * generated change against ONE synthetic input in a locked-down child process:
 *
 *   - OS sandbox (Spec 70 §4): the spawn is ALWAYS wrapped so network egress is
 *     denied AND writes are confined (`sandbox-exec` on macOS, `bwrap` on Linux, or a
 *     declared `--network none` container). No usable sandbox → FAIL CLOSED: report
 *     `infra_error` and run nothing (never a bare unsandboxed child).
 *   - Dropped ambient authority: a MINIMAL env (no secrets — no DATABASE_URL etc.),
 *     a throwaway temp `cwd`, stdin ignored.
 *   - Shimmed `@linchkit/core`: the generated `define*()` resolves to a fake; the
 *     real DB/provider wiring never loads. A recording Proxy context turns any
 *     `ctx.*` call into a `forbidden_side_effect` (the handler performs no real I/O).
 *   - Hard timeout: the child is killed past `limits.timeoutMs` → `timeout`.
 *
 * Warn-only by construction: this runner only PRODUCES a `DryRunOutcome`. Whether
 * a failing outcome blocks graduation is decided later by `strictExecutionDryRun`
 * (Spec 70 §7, default off). Core never calls this — a P3-follow-up wires it into
 * the async materialize path to stamp the durable `dryRunStatus`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  AttemptedSideEffect,
  DryRunOutcome,
  DryRunStatus,
  ExecutionDryRunProvider,
} from "@linchkit/core";
import {
  PRELOAD_FILENAME,
  PRELOAD_SOURCE,
  RUNNER_FILENAME,
  RUNNER_SOURCE,
  SOURCE_FILENAME,
} from "./child-harness";
import {
  buildSandboxArgv,
  buildSandboxExecProfile,
  defaultSandboxEnv,
  detectSandboxStrategy,
  isSandboxStrategyUsable,
  type SandboxEnv,
  type SandboxStrategy,
} from "./sandbox";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
/** How often the memory guard samples the process tree's RSS. */
const MEM_POLL_MS = 250;

/**
 * Best-effort resident-memory sample of a process AND ALL its descendants, in bytes
 * (0 if unavailable). Summing the tree (not just the root pid) is what makes the cap
 * effective under `bwrap`, where the spawned pid is the launcher and the real handler
 * runs in a descendant bun process; on macOS/trusted-container the root IS bun, so the
 * tree is just that. A single `ps` snapshot is walked by parent→child links.
 */
function readTreeRssBytes(rootPid: number): number {
  try {
    const res = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="]);
    const text = new TextDecoder().decode(res.stdout);
    const rssByPid = new Map<number, number>();
    const childrenByPid = new Map<number, number[]>();
    for (const line of text.split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 3) continue;
      const pid = Number(cols[0]);
      const ppid = Number(cols[1]);
      const kb = Number(cols[2]);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      rssByPid.set(pid, Number.isFinite(kb) && kb > 0 ? kb * 1024 : 0);
      const siblings = childrenByPid.get(ppid);
      if (siblings) siblings.push(pid);
      else childrenByPid.set(ppid, [pid]);
    }
    let total = 0;
    const queue = [rootPid];
    const seen = new Set<number>([rootPid]);
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      total += rssByPid.get(pid) ?? 0;
      for (const child of childrenByPid.get(pid) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}
/** Child statuses the harness can report. Any other value is treated as infra. */
const CHILD_STATUSES = new Set<DryRunStatus>([
  "passed",
  "threw",
  "forbidden_side_effect",
  "malformed_output",
]);

/** Raw JSON the child harness writes to the result file. */
interface ChildResult {
  status?: string;
  error?: string;
  sideEffects?: unknown;
  /** Integrity nonce stamped by the harness; verified against the value we passed. */
  __nonce?: string;
}

export interface SubprocessDryRunnerOptions {
  /** Default resource bounds when a job omits them. */
  defaultLimits?: { timeoutMs: number; memoryBytes: number };
  /** Override the sandbox/platform probe (tests). */
  sandboxEnv?: SandboxEnv;
  /** Root dir for the throwaway per-run temp dir (defaults to the OS temp dir). */
  tmpRoot?: string;
  /** Absolute path to the Bun executable for the child (defaults to this process's). */
  bunPath?: string;
}

/** Build the `infra_error` outcome (warn-only; never blocks). */
function infraOutcome(
  job: { changeName: string; target: DryRunOutcome["target"]; inputCaseId: string },
  reason: string,
): DryRunOutcome {
  return {
    changeName: job.changeName,
    target: job.target,
    status: "infra_error",
    error: reason,
    inputCaseId: job.inputCaseId,
  };
}

/**
 * Resolve the Bun executable to an absolute path. `undefined` → the current
 * executable; an absolute override is honoured as-is; a relative/bare override is
 * looked up on PATH and, failing that, falls back to the current executable — so
 * `dirname(bunPath)` can never resolve to "." (which would bind the caller's CWD
 * into the bwrap sandbox).
 */
function resolveBunPath(provided: string | undefined, env: SandboxEnv): string {
  if (!provided) return process.execPath;
  if (isAbsolute(provided)) return provided;
  return env.which(provided) ?? process.execPath;
}

/** LinchKit ActionContext methods that write to the data store. */
const CTX_DB_WRITE_OPS = new Set(["ctx.create", "ctx.update", "ctx.delete"]);
/** LinchKit ActionContext methods that read from the data store. */
const CTX_DB_READ_OPS = new Set(["ctx.get", "ctx.query"]);

/**
 * Infer the `AttemptedSideEffect.kind` from the recorded detail string. The child
 * harness emits details like `"ctx.create.<redacted>()"` or `"ctx.query(...)"` —
 * a regex captures the `ctx.<method>` prefix regardless of what follows.
 */
function inferSideEffectKind(detail: string): AttemptedSideEffect["kind"] {
  const prefix = detail.match(/^(ctx\.[a-zA-Z0-9_$]+)/)?.[1];
  if (!prefix) return "unknown";
  if (CTX_DB_WRITE_OPS.has(prefix)) return "db_write";
  if (CTX_DB_READ_OPS.has(prefix)) return "db_read";
  return "unknown";
}

/**
 * Create a hardened-subprocess `ExecutionDryRunProvider`. Each `dryRun` call runs
 * in its own throwaway temp dir, sandboxed, and is fully cleaned up afterward.
 */
export function createSubprocessDryRunner(
  options: SubprocessDryRunnerOptions = {},
): ExecutionDryRunProvider {
  const sandboxEnv = options.sandboxEnv ?? defaultSandboxEnv();
  // Resolve the Bun executable to an ABSOLUTE path. A relative/bare `bunPath`
  // (e.g. "bun") would make `dirname(bunPath)` in sandbox.ts resolve to "." and
  // bind the caller's CWD into the bwrap sandbox (leaking arbitrary files), so a
  // non-absolute override is resolved on PATH, falling back to the current
  // executable when that fails — the sandbox never exposes an unintended dir.
  const bunPath = resolveBunPath(options.bunPath, sandboxEnv);
  const defaults = options.defaultLimits ?? {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    memoryBytes: DEFAULT_MEMORY_BYTES,
  };

  // Probe the detected strategy's usability once per runner (the result is stable for
  // a given host) so a present-but-broken sandbox-exec fails closed without spawning
  // an unsandboxed child.
  const usableMemo = new Map<SandboxStrategy, boolean>();
  const strategyUsable = (strategy: SandboxStrategy): boolean => {
    let usable = usableMemo.get(strategy);
    if (usable === undefined) {
      usable = isSandboxStrategyUsable(strategy);
      usableMemo.set(strategy, usable);
    }
    return usable;
  };

  return {
    async dryRun(job): Promise<DryRunOutcome> {
      const inputCaseId = job.inputCaseId;
      const base = { changeName: job.changeName, target: job.target, inputCaseId };
      const timeoutMs = job.limits?.timeoutMs ?? defaults.timeoutMs;
      const memoryBytes = job.limits?.memoryBytes ?? defaults.memoryBytes;
      // Integrity nonce: passed to the child on STDIN (not argv/env, so it is not
      // recoverable via /proc), stamped into the real verdict, and verified below — a
      // result forged by the untrusted code cannot carry it.
      const nonce = crypto.randomUUID();

      // Fail closed when no OS sandbox can deny network egress on this host, or when
      // the detected primitive is present but cannot actually apply a sandbox.
      const strategy = detectSandboxStrategy(sandboxEnv);
      if (!strategy) {
        return infraOutcome(
          base,
          "No OS sandbox available to deny network egress on this host — failing closed (no untrusted code was run).",
        );
      }
      if (!strategyUsable(strategy)) {
        return infraOutcome(
          base,
          `The '${strategy}' sandbox is present but cannot apply a profile on this host — failing closed (no untrusted code was run).`,
        );
      }

      const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "linchkit-dryrun-"));
      const startedAt = Date.now();
      // Hoisted so `finally` can reap the child's process group on EVERY path — even a
      // handler that backgrounds a process and then returns normally leaves nothing
      // alive past the dry-run.
      let proc: ReturnType<typeof Bun.spawn> | undefined;
      const reapGroup = (): void => {
        if (!proc) return;
        try {
          // Negative pid targets the whole group (the child is its leader via
          // `detached`), reaping descendants too; fall back to the lone process.
          process.kill(-proc.pid, 9);
        } catch {
          try {
            proc.kill(9);
          } catch {
            /* already exited */
          }
        }
      };
      try {
        const sourcePath = join(dir, SOURCE_FILENAME);
        const preloadPath = join(dir, PRELOAD_FILENAME);
        const runnerPath = join(dir, RUNNER_FILENAME);
        const inputPath = join(dir, "__dryrun_input.json");
        const metaPath = join(dir, "__dryrun_meta.json");
        // Randomly named so the untrusted source (which has its argv scrubbed) cannot
        // guess the path and forge the verdict by writing it directly.
        const resultPath = join(dir, `__dryrun_result_${crypto.randomUUID()}.json`);
        const profilePath = join(dir, "__dryrun_profile.sb");

        await Promise.all([
          writeFile(sourcePath, job.source, "utf8"),
          writeFile(preloadPath, PRELOAD_SOURCE, "utf8"),
          writeFile(runnerPath, RUNNER_SOURCE, "utf8"),
          writeFile(inputPath, JSON.stringify(job.input ?? {}), "utf8"),
          writeFile(metaPath, JSON.stringify(job.metadata ?? {}), "utf8"),
          // A minimal package.json so `bun` does not walk up out of the temp dir.
          writeFile(
            join(dir, "package.json"),
            '{"name":"linchkit-dryrun-child","type":"module"}',
            "utf8",
          ),
          strategy === "sandbox-exec"
            ? writeFile(profilePath, buildSandboxExecProfile(dir), "utf8")
            : Promise.resolve(),
        ]);

        // argv[4] = the change name, so the child can disambiguate a multi-export
        // module and never silently run the wrong definition; argv[5] = the tenant id
        // exposed on the dry-run context; argv[6] = the execution-metadata JSON path.
        const childArgv = [
          bunPath,
          "--preload",
          preloadPath,
          runnerPath,
          inputPath,
          resultPath,
          job.changeName,
          job.tenantId ?? "dry-run",
          metaPath,
        ];
        const argv = buildSandboxArgv({ strategy, childArgv, tempDir: dir, profilePath });
        // Resolve the wrapper binary (argv[0]) to an absolute path so spawning does
        // not depend on the child's (minimal) PATH.
        const wrapperBin = argv[0];
        if (wrapperBin) argv[0] = sandboxEnv.which(wrapperBin) ?? wrapperBin;

        // Minimal env: enough for bun to run, but NO secrets (no inherited
        // DATABASE_URL / API keys / tokens). HOME + TMPDIR point at the throwaway dir.
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
          HOME: dir,
          TMPDIR: dir,
          LANG: process.env.LANG ?? "C",
        };

        // `detached` makes the child a process-group leader (POSIX `setsid`), so we can
        // kill the WHOLE group — reaping any subprocess the handler spawned, not just
        // the sandbox command — and nothing outlives the dry-run.
        //
        // stdout/stderr are DISCARDED, not captured: returning the untrusted child's
        // output would be an exfiltration channel (a handler that reads a host file and
        // prints it would surface its contents in the outcome). The verdict comes only
        // from the structured result file the harness writes. Discarding also means no
        // pipe a leaked descendant could hold open to defeat the timeout.
        proc = Bun.spawn(argv, {
          cwd: dir,
          env,
          stdin: new Blob([nonce]),
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        });

        // Race the child's exit against the hard timeout and a memory guard.
        let timedOut = false;
        let oomKilled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let memTimer: ReturnType<typeof setInterval> | undefined;
        const childPid = proc.pid;
        const exitCode = await Promise.race([
          proc.exited,
          new Promise<number>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              reapGroup();
              resolve(-1);
            }, timeoutMs);
            // Best-effort memory cap: sample the process tree's RSS and kill if it
            // exceeds the limit.
            memTimer = setInterval(() => {
              if (readTreeRssBytes(childPid) > memoryBytes) {
                oomKilled = true;
                reapGroup();
                resolve(-1);
              }
            }, MEM_POLL_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (memTimer) clearInterval(memTimer);

        const durationMs = Date.now() - startedAt;

        if (oomKilled) {
          return {
            ...base,
            status: "oom",
            error: `Execution exceeded the ${memoryBytes}-byte dry-run memory limit and was killed.`,
            durationMs,
          };
        }

        if (timedOut) {
          return {
            ...base,
            status: "timeout",
            error: `Execution exceeded the ${timeoutMs}ms dry-run timeout and was killed.`,
            durationMs,
          };
        }

        // The harness writes its outcome to resultPath. Its absence means the child
        // died before reporting (bun failed to start, OOM-killed, sandbox blocked
        // it) — an INFRA failure, not a content verdict.
        let childOutcome: ChildResult | null = null;
        try {
          childOutcome = (await Bun.file(resultPath).json()) as ChildResult;
        } catch {
          childOutcome = null;
        }
        if (!childOutcome || typeof childOutcome.status !== "string") {
          return infraOutcome(
            base,
            `Dry-run child produced no result (exit ${exitCode}); treating as an infrastructure failure.`,
          );
        }
        // Integrity check: only the harness knows the nonce (passed on stdin, consumed
        // before untrusted code ran). A mismatch means the result was forged or
        // truncated — never trust it as a content verdict.
        if (childOutcome.__nonce !== nonce) {
          return infraOutcome(
            base,
            "Dry-run result failed its integrity check (nonce mismatch); treating as an infrastructure failure.",
          );
        }

        const status: DryRunStatus = CHILD_STATUSES.has(childOutcome.status as DryRunStatus)
          ? (childOutcome.status as DryRunStatus)
          : "infra_error";

        const attempted = Array.isArray(childOutcome.sideEffects)
          ? (childOutcome.sideEffects as Array<{ kind?: string; detail?: string }>)
              .filter((e) => e && typeof e.detail === "string")
              .map((e) => {
                const detail = String(e.detail).slice(0, 200);
                return { kind: inferSideEffectKind(detail), detail };
              })
          : undefined;

        return {
          ...base,
          status,
          durationMs,
          ...(typeof childOutcome.error === "string"
            ? { error: childOutcome.error.slice(0, 500) }
            : {}),
          ...(attempted && attempted.length > 0 ? { attemptedSideEffects: attempted } : {}),
        };
      } catch (err) {
        // Spawn/setup failure (e.g. the sandbox binary vanished) — infra, never a
        // content verdict, so it can never wrongly block graduation.
        return infraOutcome(
          base,
          `Dry-run could not be launched: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        // Reap any process the handler may have backgrounded (normal path too), then
        // remove the throwaway dir.
        reapGroup();
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
