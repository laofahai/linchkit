/**
 * cap-dry-run — runner tier + OS resource limits (Spec 70 P5b).
 *
 * Host-independent: every test injects a fake `SandboxEnv` (and a recording fake
 * spawn), so no real gVisor/docker/bwrap/prlimit is needed and NOTHING is ever
 * actually executed. Covers:
 *
 *   - `runner: "microvm"` with no usable mechanism → FAIL CLOSED, zero spawns
 *     (never a silent fallback to the subprocess tier).
 *   - `runner: "microvm"` with a (fake) usable mechanism → the spawn argv is the
 *     docker+runsc wrapper around the IDENTICAL harness args (parity with the
 *     subprocess tier), plus the cgroup memory cap.
 *   - The default tier stays `"subprocess"`.
 *   - Linux OS memory-limit wrapper (`prlimit --data`) prefixes the sandboxed argv
 *     when available, and is absent (RSS-guard-only) otherwise.
 */

import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import {
  buildMemoryLimitArgv,
  buildMicrovmArgv,
  createDryRunner,
  createSubprocessDryRunner,
  type DryRunSpawn,
  detectMemoryLimitWrapper,
  detectMicrovmStrategy,
  isMicrovmStrategyUsable,
  type SandboxEnv,
} from "../src/index";

const MEMORY_BYTES = 256 * 1024 * 1024;

function job(overrides: { changeName?: string; tenantId?: string } = {}) {
  return {
    source: 'export const x = { name: "dry_run_probe", handler: async () => ({}) };',
    target: "action" as const,
    changeName: overrides.changeName ?? "dry_run_probe",
    input: {},
    inputCaseId: "case-0",
    ...(overrides.tenantId ? { tenantId: overrides.tenantId } : {}),
    limits: { timeoutMs: 5_000, memoryBytes: MEMORY_BYTES },
  };
}

const mkEnv = (over: Partial<SandboxEnv>): SandboxEnv => ({
  which: () => null,
  getEnv: () => undefined,
  platform: "linux",
  ...over,
});

/** docker + runsc both on PATH (the microvm mechanism is detectable). */
const MICROVM_ENV = mkEnv({
  which: (b) =>
    b === "docker" ? "/usr/bin/docker" : b === "runsc" ? "/usr/local/bin/runsc" : null,
});

/** A recording spawn that runs NOTHING: every argv is captured, the fake child
 * exits 0 immediately. The runner then finds no result file → `infra_error`,
 * which these tests ignore — they assert on the recorded argv only. */
function recordingSpawn(record: string[][]): DryRunSpawn {
  return (argv) => {
    record.push([...argv]);
    return {
      // A pid far outside any real range: `process.kill(-pid)` throws ESRCH and the
      // runner falls back to this fake's no-op kill.
      pid: 2 ** 30 + record.length,
      exited: Promise.resolve(0),
      kill: () => {},
    };
  };
}

describe("microvm strategy detection (pure, injected env)", () => {
  test("requires BOTH docker and runsc on PATH", () => {
    expect(detectMicrovmStrategy(MICROVM_ENV)).toBe("docker-runsc");
    expect(
      detectMicrovmStrategy(mkEnv({ which: (b) => (b === "docker" ? "/usr/bin/docker" : null) })),
    ).toBeNull();
    expect(
      detectMicrovmStrategy(mkEnv({ which: (b) => (b === "runsc" ? "/usr/bin/runsc" : null) })),
    ).toBeNull();
    expect(detectMicrovmStrategy(mkEnv({}))).toBeNull();
  });

  test("usability requires the daemon to list a runsc runtime", () => {
    expect(
      isMicrovmStrategyUsable("docker-runsc", () => ({
        exitCode: 0,
        stdout: '{"runc":{"path":"runc"},"runsc":{"path":"/usr/local/bin/runsc"}}',
      })),
    ).toBe(true);
    // Daemon up but no runsc runtime registered → not usable.
    expect(
      isMicrovmStrategyUsable("docker-runsc", () => ({
        exitCode: 0,
        stdout: '{"runc":{"path":"runc"}}',
      })),
    ).toBe(false);
    // Daemon down / no permission → not usable.
    expect(isMicrovmStrategyUsable("docker-runsc", () => ({ exitCode: 1, stdout: "" }))).toBe(
      false,
    );
    expect(
      isMicrovmStrategyUsable("docker-runsc", () => {
        throw new Error("docker: command not found");
      }),
    ).toBe(false);
  });

  test("buildMicrovmArgv wraps the harness args behind docker+runsc with a cgroup cap", () => {
    const argv = buildMicrovmArgv({
      strategy: "docker-runsc",
      childArgv: ["/host/bin/bun", "--preload", "/d/p.ts", "/d/r.ts"],
      tempDir: "/d",
      memoryBytes: MEMORY_BYTES,
      containerName: "linchkit-dryrun-x",
      image: "oven/bun:1",
    });
    expect(argv[0]).toBe("docker");
    expect(argv).toContain("--runtime=runsc");
    expect(argv).toContain("--network=none");
    expect(argv).toContain("--read-only");
    expect(argv).toContain(`--memory=${MEMORY_BYTES}`);
    expect(argv).toContain("--cap-drop=ALL");
    // The per-run temp dir is bind-mounted at the SAME absolute path…
    expect(argv).toContain("/d:/d");
    // …and the host bun path is replaced by the image's `bun` running the IDENTICAL
    // harness args.
    expect(argv.slice(argv.indexOf("oven/bun:1") + 1)).toEqual([
      "bun",
      "--preload",
      "/d/p.ts",
      "/d/r.ts",
    ]);
  });
});

describe("OS memory-limit wrapper detection (pure, injected env)", () => {
  test("linux + prlimit on PATH → prlimit; otherwise guard-only (null)", () => {
    expect(
      detectMemoryLimitWrapper(
        mkEnv({ which: (b) => (b === "prlimit" ? "/usr/bin/prlimit" : null) }),
      ),
    ).toBe("prlimit");
    expect(detectMemoryLimitWrapper(mkEnv({}))).toBeNull();
    // Not Linux → never an rlimit wrapper, even if a `prlimit` binary exists.
    expect(
      detectMemoryLimitWrapper(
        mkEnv({ platform: "darwin", which: (b) => (b === "prlimit" ? "/x/prlimit" : null) }),
      ),
    ).toBeNull();
  });

  test("buildMemoryLimitArgv prefixes prlimit --data OUTSIDE the sandboxed argv", () => {
    expect(
      buildMemoryLimitArgv({
        wrapper: "prlimit",
        memoryBytes: MEMORY_BYTES,
        argv: ["bwrap", "--unshare-net", "--", "/bin/bun", "x.ts"],
      }),
    ).toEqual([
      "prlimit",
      `--data=${MEMORY_BYTES}`,
      "--",
      "bwrap",
      "--unshare-net",
      "--",
      "/bin/bun",
      "x.ts",
    ]);
  });
});

describe("createDryRunner — microvm tier fails closed (nothing spawned)", () => {
  test("microvm configured + runsc absent → infra_error, zero spawns, no fallback", async () => {
    const record: string[][] = [];
    const runner = createDryRunner({
      runner: "microvm",
      // docker present, runsc absent — the subprocess tier WOULD be available here
      // (bwrap on PATH), proving the fail-closed path never silently degrades.
      sandboxEnv: mkEnv({
        which: (b) => (b === "docker" || b === "bwrap" ? `/usr/bin/${b}` : null),
      }),
      spawn: recordingSpawn(record),
    });
    const outcome = await runner.dryRun(job());
    expect(outcome.status).toBe("infra_error");
    expect(outcome.error ?? "").toContain("microvm runner unavailable");
    expect(outcome.error ?? "").toContain("failing closed");
    expect(record).toHaveLength(0);
  });

  test("microvm configured + runsc present but daemon has no runsc runtime → fail closed", async () => {
    const record: string[][] = [];
    const runner = createDryRunner({
      runner: "microvm",
      sandboxEnv: MICROVM_ENV,
      microvmProbe: () => false,
      spawn: recordingSpawn(record),
    });
    const outcome = await runner.dryRun(job());
    expect(outcome.status).toBe("infra_error");
    expect(outcome.error ?? "").toContain("microvm runner unavailable");
    expect(record).toHaveLength(0);
  });

  test("default runner stays subprocess: no-sandbox env reports the SANDBOX message", async () => {
    const runner = createDryRunner({
      sandboxEnv: mkEnv({ platform: "darwin" }),
      spawn: recordingSpawn([]),
    });
    const outcome = await runner.dryRun(job());
    expect(outcome.status).toBe("infra_error");
    expect(outcome.error ?? "").toContain("No OS sandbox available");
    expect(outcome.error ?? "").not.toContain("microvm");
  });

  test("createSubprocessDryRunner remains exported and accepts the runner option", async () => {
    const record: string[][] = [];
    const runner = createSubprocessDryRunner({
      runner: "microvm",
      sandboxEnv: mkEnv({}),
      spawn: recordingSpawn(record),
    });
    const outcome = await runner.dryRun(job());
    expect(outcome.status).toBe("infra_error");
    expect(outcome.error ?? "").toContain("microvm runner unavailable");
    expect(record).toHaveLength(0);
  });
});

describe("createDryRunner — microvm tier spawn argv + subprocess parity", () => {
  test("usable microvm → docker+runsc wrapper, identical harness args, container reaped", async () => {
    const microvmRecord: string[][] = [];
    const microvmRunner = createDryRunner({
      runner: "microvm",
      sandboxEnv: MICROVM_ENV,
      microvmProbe: () => true,
      spawn: recordingSpawn(microvmRecord),
    });
    const microvmOutcome = await microvmRunner.dryRun(job({ tenantId: "t-1" }));
    // The fake child writes no result file → infra (NOT a fail-closed message); the
    // assertions below are about the recorded argv.
    expect(microvmOutcome.status).toBe("infra_error");
    expect(microvmOutcome.error ?? "").not.toContain("unavailable");

    // Subprocess tier reference run (trusted-container → bare harness argv).
    const subRecord: string[][] = [];
    const subRunner = createDryRunner({
      sandboxEnv: mkEnv({
        getEnv: (k) => (k === "LINCHKIT_DRYRUN_TRUST_CONTAINER" ? "1" : undefined),
      }),
      spawn: recordingSpawn(subRecord),
    });
    await subRunner.dryRun(job({ tenantId: "t-1" }));

    expect(microvmRecord.length).toBeGreaterThanOrEqual(1);
    const argv = microvmRecord[0] as string[];
    // argv[0] is resolved to the fake env's absolute docker path.
    expect(argv[0]).toBe("/usr/bin/docker");
    expect(argv[1]).toBe("run");
    expect(argv).toContain("--runtime=runsc");
    expect(argv).toContain("--network=none");
    expect(argv).toContain("--read-only");
    expect(argv).toContain(`--memory=${MEMORY_BYTES}`);
    // The per-run temp dir is bind-mounted at the same absolute path.
    expect(argv.some((a) => /linchkit-dryrun-.+:.+linchkit-dryrun-/.test(a))).toBe(true);

    // PARITY: the in-container command is the IDENTICAL launcher the subprocess tier
    // runs — same arg count, same flags, same harness filenames, same change/tenant.
    const imageIdx = argv.indexOf("oven/bun:1");
    expect(imageIdx).toBeGreaterThan(0);
    const tail = argv.slice(imageIdx + 1);
    const sub = subRecord[0] as string[];
    expect(tail).toHaveLength(sub.length);
    expect(tail[0]).toBe("bun"); // image-provided bun replaces the host bun path
    expect(tail[1]).toBe("--preload");
    expect(sub[1]).toBe("--preload");
    // Harness files have identical names (temp dirs differ per run).
    for (const i of [2, 3, 4, 8]) {
      expect(basename(tail[i] as string)).toBe(basename(sub[i] as string));
    }
    expect(basename(tail[5] as string)).toStartWith("__dryrun_result_");
    expect(basename(sub[5] as string)).toStartWith("__dryrun_result_");
    expect(tail[6]).toBe("dry_run_probe");
    expect(sub[6]).toBe("dry_run_probe");
    expect(tail[7]).toBe("t-1");
    expect(sub[7]).toBe("t-1");

    // Reap: the runner `docker kill`s the named container (killing the attached
    // client alone would leave it running).
    const nameIdx = argv.indexOf("--name");
    const containerName = argv[nameIdx + 1] as string;
    expect(containerName).toStartWith("linchkit-dryrun-");
    expect(microvmRecord.some((a) => a[1] === "kill" && a[2] === containerName)).toBe(true);
  });
});

describe("createDryRunner — Linux OS memory-limit wrapper (subprocess tier)", () => {
  test("prlimit available → argv is prlimit --data -- bwrap …", async () => {
    const record: string[][] = [];
    const runner = createDryRunner({
      sandboxEnv: mkEnv({
        which: (b) => (b === "bwrap" || b === "prlimit" ? `/usr/bin/${b}` : null),
      }),
      spawn: recordingSpawn(record),
    });
    await runner.dryRun(job());
    expect(record).toHaveLength(1);
    const argv = record[0] as string[];
    expect(argv[0]).toBe("/usr/bin/prlimit");
    expect(argv[1]).toBe(`--data=${MEMORY_BYTES}`);
    expect(argv[2]).toBe("--");
    expect(argv[3]).toBe("bwrap");
    expect(argv).toContain("--unshare-net");
  });

  test("prlimit absent → sandbox argv unchanged (RSS guard remains the only cap)", async () => {
    const record: string[][] = [];
    const runner = createDryRunner({
      sandboxEnv: mkEnv({ which: (b) => (b === "bwrap" ? "/usr/bin/bwrap" : null) }),
      spawn: recordingSpawn(record),
    });
    await runner.dryRun(job());
    expect(record).toHaveLength(1);
    const argv = record[0] as string[];
    expect(argv[0]).toBe("/usr/bin/bwrap");
    expect(argv).not.toContain("prlimit");
    expect(argv).toContain("--unshare-net");
  });
});
