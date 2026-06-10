/**
 * OS-level sandbox strategy for the execution dry-run (Spec 70 §4).
 *
 * The dry-run runs UNTRUSTED AI-generated code in a child process. A bare
 * `Bun.spawn` does NOT deny network egress, so the spawn is ALWAYS wrapped in a
 * platform-appropriate OS sandbox whose non-negotiable job is to **deny network
 * egress** (the exfiltration vector). If no usable primitive exists on this host,
 * detection returns `null` and the runner FAILS CLOSED — it reports `infra_error`
 * and runs nothing, never a bare unsandboxed child (Spec 70 §3).
 *
 * Strategy ladder:
 *   - darwin  → `sandbox-exec` with a deny-network profile (always present on macOS).
 *   - linux   → `bwrap` (rootless bubblewrap): denies network AND confines writes to
 *     a per-run bind (read-only root). `unshare` alone is NOT used: it would deny the
 *     network but leave the host filesystem writable, so untrusted code could tamper
 *     with the repo yet be reported `passed` — a sandbox must deny BOTH egress and
 *     out-of-sandbox writes, so without `bwrap` Linux fails closed.
 *   - any OS  → `LINCHKIT_DRYRUN_TRUST_CONTAINER=1` declares the process is ALREADY
 *     inside a network-denied container (orchestration provides isolation), so a
 *     bare subprocess is acceptable. Set this ONLY when the deployment guarantees
 *     it (e.g. a `--network none` / NetworkPolicy-denied pod with a read-only rootfs).
 *   - else    → `null` (fail closed).
 */

import { realpathSync } from "node:fs";
import { platform } from "node:os";
import { dirname } from "node:path";

export type SandboxStrategy = "sandbox-exec" | "bwrap" | "trusted-container";

export interface SandboxEnv {
  /** Looks up an executable on PATH; returns its path or null. Injectable for tests. */
  which: (bin: string) => string | null;
  /** Reads an env var; injectable for tests. */
  getEnv: (key: string) => string | undefined;
  /** The OS platform string (`process.platform`); injectable for tests. */
  platform: NodeJS.Platform;
}

/** Default environment probe backed by Bun/Node. */
export function defaultSandboxEnv(): SandboxEnv {
  return {
    which: (bin) => Bun.which(bin),
    getEnv: (key) => process.env[key],
    platform: platform() as NodeJS.Platform,
  };
}

/**
 * Detect a usable OS sandbox that can deny network egress for an untrusted child.
 * Returns `null` when none is available — the caller MUST then fail closed.
 */
export function detectSandboxStrategy(
  env: SandboxEnv = defaultSandboxEnv(),
): SandboxStrategy | null {
  // An explicit operator opt-in: the surrounding container already denies the
  // network. Honoured on any platform.
  if (env.getEnv("LINCHKIT_DRYRUN_TRUST_CONTAINER") === "1") return "trusted-container";

  if (env.platform === "darwin") {
    return env.which("sandbox-exec") ? "sandbox-exec" : null;
  }
  if (env.platform === "linux") {
    // Only `bwrap` is trusted: it denies the network AND confines filesystem writes
    // (read-only root + a per-run writable bind). `unshare` would leave the host fs
    // writable, so we deliberately fail closed without bwrap.
    return env.which("bwrap") ? "bwrap" : null;
  }
  // Unknown platform → no network-denial primitive we trust → fail closed.
  return null;
}

/**
 * Verify a detected strategy is actually USABLE, not merely present on PATH. On some
 * macOS hosts `/usr/bin/sandbox-exec` exists but cannot apply a profile (restricted
 * or already-nested sandbox); there every dry-run would return `infra_error`. We
 * probe by applying a trivial profile to `/usr/bin/true` — a non-zero exit means the
 * primitive is broken, so the caller must fail closed. `bwrap`/`trusted-container`
 * are assumed usable when present (a broken `bwrap` still yields `infra_error` at run
 * time, which fails closed). `run` is injectable for host-independent tests.
 */
export function isSandboxStrategyUsable(
  strategy: SandboxStrategy,
  run: (argv: string[]) => { exitCode: number | null } = (argv) => Bun.spawnSync(argv),
): boolean {
  if (strategy !== "sandbox-exec") return true;
  try {
    return (
      run(["sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"]).exitCode === 0
    );
  } catch {
    return false;
  }
}

/** Home-relative paths that commonly hold credentials, denied for reads (defense in
 * depth — the runner also never surfaces handler output, so a read has no egress). */
const SECRET_HOME_SUBPATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config",
  ".kube",
  ".docker",
  ".gcloud",
  ".azure",
];
const SECRET_HOME_FILES = [".npmrc", ".netrc", ".pgpass", ".git-credentials"];

/**
 * The macOS `sandbox-exec` profile: deny ALL network, deny file WRITES outside THIS
 * run's temp dir (so a handler cannot tamper with the repo, the system, or a shared
 * temp path like `/tmp/leak`), and deny READS of common credential locations under the
 * caller's home. A full deny-default read sandbox is impractical for a runtime like bun
 * (it needs broad library reads), so airtight read-isolation is the P5 microVM tier;
 * here the read blocklist plus the runner never surfacing handler stdout/stderr remove
 * the practical exfiltration path.
 *
 * Writes are scoped to the per-run dir only. `mkdtemp` returns a `/var/folders/…`
 * (or `/tmp/…`) path while the kernel canonicalises it to `/private/…` before the
 * sandbox matches it, so we allow BOTH the given path and its realpath.
 */
export function buildSandboxExecProfile(tempDir: string): string {
  const writable = new Set<string>([tempDir]);
  try {
    writable.add(realpathSync(tempDir));
  } catch {
    // tempDir may not exist yet in a unit test; the given path is still emitted.
  }
  const home = process.env.HOME;
  const denyReads = home
    ? [
        "(deny file-read*",
        ...SECRET_HOME_SUBPATHS.map((p) => `  (subpath ${JSON.stringify(`${home}/${p}`)})`),
        ...SECRET_HOME_FILES.map((f) => `  (literal ${JSON.stringify(`${home}/${f}`)})`),
        ")",
      ]
    : [];
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    ...denyReads,
    "(deny file-write*)",
    "(allow file-write*",
    ...[...writable].map((p) => `  (subpath ${JSON.stringify(p)})`),
    '  (literal "/dev/null")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    // No `/dev/tty`: the child runs with stdout/stderr discarded, so it needs no
    // controlling terminal — denying tty writes removes a terminal-hijack (escape
    // sequence injection) vector.
    '  (literal "/dev/dtracehelper"))',
    "",
  ].join("\n");
}

/**
 * Wrap the child command with the chosen sandbox so the resulting argv can be
 * handed to `Bun.spawn`. `profilePath` is required for `sandbox-exec` (the path of
 * a profile written via {@link buildSandboxExecProfile}); `tempDir` is the
 * writable working dir bound into the sandbox.
 */
export function buildSandboxArgv(args: {
  strategy: SandboxStrategy;
  childArgv: readonly string[];
  tempDir: string;
  profilePath?: string;
}): string[] {
  const { strategy, childArgv, tempDir, profilePath } = args;
  switch (strategy) {
    case "sandbox-exec": {
      if (!profilePath) throw new Error("sandbox-exec requires a profilePath");
      return ["sandbox-exec", "-f", profilePath, ...childArgv];
    }
    case "bwrap":
      // Rootless bubblewrap: no network, read-only root, a writable bind for the
      // temp dir, an ephemeral /tmp, and die-with-parent so a leaked child is
      // reaped. `--new-session` drops the controlling terminal.
      //
      // `--tmpfs /tmp` hides the host /tmp, which is where `mkdtemp` usually puts
      // `tempDir`. `--dir tempDir` recreates the bind TARGET inside that fresh tmpfs
      // BEFORE `--bind` (bubblewrap requires the destination to exist), otherwise
      // every Linux dry-run would fail to launch.
      return [
        "bwrap",
        "--unshare-all",
        "--unshare-net",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        // Hide credential-bearing home dirs from the read-only root (defense in depth;
        // bun runs with HOME pointed at the temp dir, so it needs neither).
        "--tmpfs",
        "/root",
        "--tmpfs",
        "/home",
        // …but the Bun executable itself often lives under the home dir (~/.bun/bin),
        // which the tmpfs just masked — re-expose its directory so the child can launch.
        "--ro-bind-try",
        dirname(childArgv[0] ?? ""),
        dirname(childArgv[0] ?? ""),
        "--dir",
        tempDir,
        "--bind",
        tempDir,
        tempDir,
        "--chdir",
        tempDir,
        "--",
        ...childArgv,
      ];
    case "trusted-container":
      // The orchestration already denies the network; run the child directly.
      return [...childArgv];
  }
}

// ── microVM runner tier (Spec 70 §4 escalation tier, P5) ──────────────────────

/**
 * Mechanisms that give the dry-run a KERNEL boundary (gVisor). The one mechanism we
 * trust is the production gVisor integration: a container engine driving the `runsc`
 * OCI runtime (`docker run --runtime=runsc`). A direct `runsc do` is deliberately NOT
 * a strategy: it overlays the host root filesystem, so the harness's result-file write
 * is discarded with the sandbox and every run would report `infra_error`; turning the
 * overlay off would leave the host filesystem writable — worse than the subprocess tier.
 */
export type MicrovmStrategy = "docker-runsc";

/**
 * Detect a usable microVM mechanism. Requires BOTH `docker` (the engine that builds
 * the OCI sandbox with mounts) and `runsc` (gVisor) on PATH; whether the Docker daemon
 * actually has the runsc runtime registered is verified separately by
 * {@link isMicrovmStrategyUsable}. Returns `null` when absent — the caller MUST then
 * fail closed (a configured microvm tier NEVER silently degrades to the subprocess
 * tier; that would report a weaker boundary as the stronger one).
 */
export function detectMicrovmStrategy(
  env: SandboxEnv = defaultSandboxEnv(),
): MicrovmStrategy | null {
  if (env.which("docker") && env.which("runsc")) return "docker-runsc";
  return null;
}

/**
 * Verify the detected microVM mechanism is actually USABLE: `runsc` being on PATH does
 * not mean the Docker daemon has it registered as a runtime. We ask the daemon for its
 * runtime table and require a `runsc` entry; any failure (daemon down, no permission,
 * no runsc runtime) → not usable → the caller fails closed. `run` is injectable for
 * host-independent tests.
 */
export function isMicrovmStrategyUsable(
  _strategy: MicrovmStrategy,
  run: (argv: string[]) => { exitCode: number | null; stdout?: string } = (argv) => {
    const res = Bun.spawnSync(argv);
    return { exitCode: res.exitCode, stdout: new TextDecoder().decode(res.stdout) };
  },
): boolean {
  try {
    const res = run(["docker", "info", "--format", "{{json .Runtimes}}"]);
    return res.exitCode === 0 && (res.stdout ?? "").includes('"runsc"');
  } catch {
    return false;
  }
}

/**
 * Wrap the child harness command so it runs inside a gVisor microVM via
 * `docker run --runtime=runsc`. The launcher interface is unchanged (Spec 70 §4):
 * the IDENTICAL harness args run, only the spawn wrapper differs.
 *
 *   - `--network=none` — egress denial (parity with sandbox-exec/bwrap), now behind
 *     a kernel boundary.
 *   - `--read-only` + a single writable bind of the per-run temp dir at the SAME
 *     absolute path — parity with the bwrap read-only root, and it lets the parent
 *     read the harness's result file after exit.
 *   - `--memory`/`--memory-swap` — the OS-ENFORCED memory cap for this tier (cgroup,
 *     enforced by the engine; the host-side RSS poll stays as defense in depth).
 *   - `--cap-drop=ALL --security-opt=no-new-privileges --pids-limit` — least privilege
 *     and a fork-bomb bound.
 *   - `childArgv[0]` (the HOST bun path) is replaced by the image's `bun`: the host
 *     binary does not exist inside the container, while every other harness arg is an
 *     absolute path under the bind-mounted temp dir, identical inside and out.
 *   - `--name` gives the parent a handle to `docker kill` on timeout/OOM reap —
 *     killing the attached `docker run` client does NOT stop the container.
 *
 * Everything is built as an argv array (never shell-interpolated); the only embedded
 * paths are the runner-owned `mkdtemp` dir, never the untrusted source.
 */
export function buildMicrovmArgv(args: {
  strategy: MicrovmStrategy;
  childArgv: readonly string[];
  tempDir: string;
  memoryBytes: number;
  containerName: string;
  image: string;
}): string[] {
  const { childArgv, tempDir, memoryBytes, containerName, image } = args;
  const harnessArgs = childArgv.slice(1);
  return [
    "docker",
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    "--runtime=runsc",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    `--memory=${memoryBytes}`,
    `--memory-swap=${memoryBytes}`,
    "-v",
    `${tempDir}:${tempDir}`,
    "-w",
    tempDir,
    "-e",
    `HOME=${tempDir}`,
    "-e",
    `TMPDIR=${tempDir}`,
    image,
    "bun",
    ...harnessArgs,
  ];
}

// ── OS-enforced memory limit (subprocess tier) ────────────────────────────────

/** The one OS memory-limit mechanism the subprocess tier uses (see below). */
export type MemoryLimitWrapper = "prlimit";

/**
 * Detect an OS-enforced memory-limit wrapper for the subprocess tier. Linux only:
 * `prlimit(1)` (util-linux) applies an rlimit to the command it execs, and rlimits
 * inherit across exec/fork — wrapping the OUTERMOST command caps every descendant,
 * including the bun that runs the untrusted handler inside bwrap.
 *
 * macOS has no equivalent (`sandbox-exec` cannot enforce memory and there is no
 * prlimit), so there the RSS-polling guard remains the only memory bound — returning
 * `null` here means "guard-only", which is hardening lost, NOT a security failure
 * (egress denial is the boundary), so the caller does NOT fail closed.
 */
export function detectMemoryLimitWrapper(
  env: SandboxEnv = defaultSandboxEnv(),
): MemoryLimitWrapper | null {
  if (env.platform !== "linux") return null;
  return env.which("prlimit") ? "prlimit" : null;
}

/**
 * Prefix the (already sandbox-wrapped) argv with the OS memory limit.
 *
 * Mechanism choice — `prlimit --data=<bytes>` (RLIMIT_DATA), deliberately NOT
 * `--as` (RLIMIT_AS) and NOT a `sh -c 'ulimit -v …'` wrapper:
 *   - RLIMIT_AS caps VIRTUAL address space, and a modern JS engine reserves multi-GiB
 *     PROT_NONE regions at startup — an `--as` cap at the dry-run budget would stop
 *     the child from even launching.
 *   - RLIMIT_DATA (Linux ≥ 4.7) covers brk + writable private anonymous mappings —
 *     the memory a runaway allocation actually commits — while ignoring those
 *     untouched reservations.
 *   - A `sh -c` wrapper would put the harness argv through a shell; argv arrays only.
 *
 * When the OS limit fires, the child's allocation fails (the run surfaces as `threw`
 * or, if bun aborts, `infra_error`); the RSS-polling guard stays active on all
 * platforms as defense in depth and still provides the precise `oom` classification.
 *
 * Ordering: the limit wraps OUTSIDE the sandbox (`prlimit -- bwrap -- bun …`) —
 * rlimits inherit into the sandboxed child, and this keeps the limit binary outside
 * the confined filesystem view.
 */
export function buildMemoryLimitArgv(args: {
  wrapper: MemoryLimitWrapper;
  memoryBytes: number;
  argv: readonly string[];
}): string[] {
  return ["prlimit", `--data=${args.memoryBytes}`, "--", ...args.argv];
}
