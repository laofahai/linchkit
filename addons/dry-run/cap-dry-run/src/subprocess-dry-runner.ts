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
import type { DryRunOutcome, DryRunStatus, ExecutionDryRunProvider } from "@linchkit/core";
import {
  PRELOAD_FILENAME,
  PRELOAD_SOURCE,
  RUNNER_FILENAME,
  RUNNER_SOURCE,
  SOURCE_FILENAME,
} from "./child-harness";
import {
  buildMemoryLimitArgv,
  buildMicrovmArgv,
  buildSandboxArgv,
  buildSandboxExecProfile,
  defaultSandboxEnv,
  detectMemoryLimitWrapper,
  detectMicrovmStrategy,
  detectSandboxStrategy,
  isMicrovmStrategyUsable,
  isSandboxStrategyUsable,
  type MicrovmStrategy,
  type SandboxEnv,
  type SandboxStrategy,
} from "./sandbox";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MEMORY_BYTES = 256 * 1024 * 1024;
/** Default image for the microvm tier — bun must exist inside the container. */
const DEFAULT_MICROVM_IMAGE = "oven/bun:1";
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

/** Runner tiers (Spec 70 §4): the hardened OS-process default, or the gVisor
 * kernel-boundary escalation tier. The launcher (harness files + argv) is IDENTICAL;
 * only the spawn wrapper differs. */
export type DryRunnerTier = "subprocess" | "microvm";

/** The subset of `Bun.spawn`'s subprocess handle the runner relies on. */
export interface SpawnedDryRunChild {
  pid: number;
  exited: Promise<number>;
  kill(signal?: number): void;
}

/** Spawn seam: the runner always passes a fully built argv array (never a shell
 * string); the default implementation is a detached, output-discarding `Bun.spawn`.
 * Injectable so tests can record the exact argv without running anything. */
export type DryRunSpawn = (
  argv: string[],
  options: { cwd: string; env: Record<string, string>; stdin: Blob },
) => SpawnedDryRunChild;

const defaultSpawn: DryRunSpawn = (argv, options) =>
  // `detached` → process-group leader (whole-tree reaping); stdout/stderr DISCARDED
  // (captured untrusted output would be an exfiltration channel — see dryRun()).
  Bun.spawn(argv, { ...options, stdout: "ignore", stderr: "ignore", detached: true });

export interface SubprocessDryRunnerOptions {
  /**
   * Which isolation tier wraps the spawn (default `"subprocess"`). A configured
   * `"microvm"` tier with no usable gVisor mechanism on the host FAILS CLOSED
   * (`infra_error`, nothing runs) — it never silently degrades to the subprocess
   * tier, which would report a weaker boundary as the stronger one.
   */
  runner?: DryRunnerTier;
  /** Default resource bounds when a job omits them. */
  defaultLimits?: { timeoutMs: number; memoryBytes: number };
  /** Override the sandbox/platform probe (tests). */
  sandboxEnv?: SandboxEnv;
  /** Root dir for the throwaway per-run temp dir (defaults to the OS temp dir). */
  tmpRoot?: string;
  /** Absolute path to the Bun executable for the child (defaults to this process's). */
  bunPath?: string;
  /** Container image for the microvm tier; must provide `bun` (default `oven/bun:1`). */
  microvmImage?: string;
  /** Override the microvm usability probe (tests). */
  microvmProbe?: (strategy: MicrovmStrategy) => boolean;
  /** Override the spawn (tests record argv instead of running). */
  spawn?: DryRunSpawn;
}

/** Preferred options alias now that the factory selects the runner tier. */
export type DryRunnerOptions = SubprocessDryRunnerOptions;

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

/**
 * Create a hardened `ExecutionDryRunProvider`. Each `dryRun` call runs in its own
 * throwaway temp dir, sandboxed, and is fully cleaned up afterward. The isolation
 * tier is selected by `options.runner` (Spec 70 §4):
 *
 *   - `"subprocess"` (default) — OS-sandboxed Bun child (`sandbox-exec`/`bwrap`/
 *     trusted container), plus an OS-enforced memory rlimit on Linux when
 *     `prlimit` is available (`prlimit --data -- <sandbox argv>`).
 *   - `"microvm"` — the IDENTICAL launcher inside a gVisor kernel boundary
 *     (`docker run --runtime=runsc --network=none --read-only --memory=…`). No
 *     usable mechanism → FAIL CLOSED, never a silent subprocess fallback.
 */
export function createDryRunner(options: DryRunnerOptions = {}): ExecutionDryRunProvider {
  const sandboxEnv = options.sandboxEnv ?? defaultSandboxEnv();
  const tier: DryRunnerTier = options.runner ?? "subprocess";
  const spawnChild = options.spawn ?? defaultSpawn;
  const microvmProbe = options.microvmProbe ?? isMicrovmStrategyUsable;
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
  // Same once-per-runner memo for the microvm mechanism (docker daemon runtime table).
  const microvmUsableMemo = new Map<MicrovmStrategy, boolean>();
  const microvmUsable = (strategy: MicrovmStrategy): boolean => {
    let usable = microvmUsableMemo.get(strategy);
    if (usable === undefined) {
      usable = microvmProbe(strategy);
      microvmUsableMemo.set(strategy, usable);
    }
    return usable;
  };
  // The OS memory-limit wrapper for the subprocess tier (Linux `prlimit`; `null` on
  // platforms without one → the RSS-polling guard alone bounds memory there).
  const memoryLimitWrapper = detectMemoryLimitWrapper(sandboxEnv);

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

      // Resolve the isolation wrapper for the configured tier BEFORE anything is
      // written or spawned. Each tier fails closed on its own terms; a configured
      // microvm tier NEVER falls back to the subprocess tier (a stronger configured
      // boundary silently degrading would misreport the isolation actually applied).
      let strategy: SandboxStrategy | null = null;
      let microvm: MicrovmStrategy | null = null;
      if (tier === "microvm") {
        microvm = detectMicrovmStrategy(sandboxEnv);
        if (!microvm) {
          return infraOutcome(
            base,
            "microvm runner unavailable (no gVisor `runsc` + container engine on this host) — failing closed; no untrusted code was run.",
          );
        }
        if (!microvmUsable(microvm)) {
          return infraOutcome(
            base,
            "microvm runner unavailable (`runsc` is present but the container engine has no runsc runtime registered) — failing closed; no untrusted code was run.",
          );
        }
      } else {
        // Fail closed when no OS sandbox can deny network egress on this host, or when
        // the detected primitive is present but cannot actually apply a sandbox.
        strategy = detectSandboxStrategy(sandboxEnv);
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
      }

      const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "linchkit-dryrun-"));
      const startedAt = Date.now();
      // Hoisted so `finally` can reap the child's process group on EVERY path — even a
      // handler that backgrounds a process and then returns normally leaves nothing
      // alive past the dry-run.
      let proc: SpawnedDryRunChild | undefined;
      // microvm only: the per-run container name, so reaping can `docker kill` it —
      // killing the attached `docker run` CLIENT does not stop the container.
      const containerName =
        tier === "microvm" ? `linchkit-dryrun-${crypto.randomUUID()}` : undefined;
      const reapGroup = (): void => {
        if (containerName) {
          // Fire-and-forget; an already-exited `--rm` container makes this a no-op
          // error we ignore. Goes through the same spawn seam (argv array, no shell).
          try {
            const dockerBin = sandboxEnv.which("docker") ?? "docker";
            spawnChild([dockerBin, "kill", containerName], {
              cwd: options.tmpRoot ?? tmpdir(),
              env: { PATH: sandboxEnv.getEnv("PATH") ?? "/usr/bin:/bin:/usr/local/bin" },
              stdin: new Blob([]),
            }).exited.catch(() => {});
          } catch {
            /* best effort */
          }
        }
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
        // Wrapper ordering (outermost → innermost):
        //   subprocess tier: [prlimit (linux, when present)] → sandbox (bwrap /
        //     sandbox-exec / bare-in-trusted-container) → bun harness. The rlimit
        //     inherits across exec into the sandboxed bun, and keeping it outermost
        //     keeps the limit binary outside the confined filesystem view.
        //   microvm tier: docker(runsc) → bun harness. The cgroup `--memory` flag IS
        //     this tier's OS-enforced cap, so no prlimit; the kernel boundary
        //     subsumes the OS sandbox wrappers.
        // All layers are argv arrays — nothing is ever shell-interpolated.
        let argv: string[];
        if (microvm && containerName) {
          argv = buildMicrovmArgv({
            strategy: microvm,
            childArgv,
            tempDir: dir,
            memoryBytes,
            containerName,
            image: options.microvmImage ?? DEFAULT_MICROVM_IMAGE,
          });
        } else if (strategy) {
          argv = buildSandboxArgv({ strategy, childArgv, tempDir: dir, profilePath });
          if (memoryLimitWrapper) {
            argv = buildMemoryLimitArgv({ wrapper: memoryLimitWrapper, memoryBytes, argv });
          }
        } else {
          // Unreachable: detection above either set a wrapper or failed closed.
          return infraOutcome(base, "No isolation wrapper resolved — failing closed.");
        }
        // Resolve the wrapper binary (argv[0]) to an absolute path so spawning does
        // not depend on the child's (minimal) PATH.
        const wrapperBin = argv[0];
        if (wrapperBin) argv[0] = sandboxEnv.which(wrapperBin) ?? wrapperBin;

        // Minimal env: enough for bun to run, but NO secrets (no inherited
        // DATABASE_URL / API keys / tokens). HOME + TMPDIR point at the throwaway dir.
        // The microvm tier additionally passes DOCKER_HOST through so the client can
        // reach a non-default daemon socket (it carries no secret material).
        const dockerHost = sandboxEnv.getEnv("DOCKER_HOST");
        const env: Record<string, string> = {
          PATH: sandboxEnv.getEnv("PATH") ?? "/usr/bin:/bin:/usr/local/bin",
          HOME: dir,
          TMPDIR: dir,
          LANG: sandboxEnv.getEnv("LANG") ?? "C",
          ...(microvm && dockerHost ? { DOCKER_HOST: dockerHost } : {}),
        };

        // The default spawn is `detached` (process-group leader, POSIX `setsid`), so we
        // can kill the WHOLE group — reaping any subprocess the handler spawned, not
        // just the wrapper command — and nothing outlives the dry-run.
        //
        // stdout/stderr are DISCARDED, not captured: returning the untrusted child's
        // output would be an exfiltration channel (a handler that reads a host file and
        // prints it would surface its contents in the outcome). The verdict comes only
        // from the structured result file the harness writes. Discarding also means no
        // pipe a leaked descendant could hold open to defeat the timeout.
        proc = spawnChild(argv, {
          cwd: dir,
          env,
          stdin: new Blob([nonce]),
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
              .map((e) => ({
                kind: "unknown" as const,
                detail: String(e.detail).slice(0, 200),
              }))
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

/**
 * Back-compat alias of {@link createDryRunner} — the original Spec 70 P3 export.
 * Identical behaviour (including the optional `runner` tier selection).
 */
export const createSubprocessDryRunner = createDryRunner;
