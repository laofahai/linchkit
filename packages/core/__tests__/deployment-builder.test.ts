import { describe, expect, it } from "bun:test";
import { DeployBuilder, type ExecResult, type ProcessExecutor } from "../src/deployment/builder";

const REPO_DIR = "/tmp/fake-repo";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Test helpers ─────────────────────────────────────────────────────────

function ok(stdout: string, stderr = ""): ExecResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(stderr: string, exitCode = 1, stdout = ""): ExecResult {
  return { stdout, stderr, exitCode };
}

/**
 * Builds an executor that maps "cmd arg1 arg2" keys to ExecResult values.
 * Throws for any unmapped command so tests fail fast on unexpected calls.
 */
function makeExecutor(responses: Record<string, ExecResult>): ProcessExecutor {
  return async (cmd, args, _cwd) => {
    const key = [cmd, ...args].join(" ");
    const result = responses[key];
    if (result === undefined) throw new Error(`Unexpected exec call: "${key}"`);
    return result;
  };
}

/** Executor that resolves after a delay — used for timeout tests */
function slowExecutor(delayMs: number): ProcessExecutor {
  return async (_cmd, _args, _cwd) =>
    new Promise((resolve) => setTimeout(() => resolve(ok("done")), delayMs));
}

// ── Successful build paths ────────────────────────────────────────────────

describe("DeployBuilder — success paths", () => {
  it("reports upToDate and skips install + build when already up to date", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Already up to date.\n"),
      "bun run build": ok("Build succeeded"),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.upToDate).toBe(true);
    expect(result.depsChanged).toBe(false);
    expect(result.installOutput).toBeUndefined();
    expect(result.buildOutput).toContain("Build succeeded");
  });

  it("runs build without install when changed files do not include lockfiles", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Updating abc..def\nFast-forward\n src/foo.ts | 1 +\n"),
      "git diff --name-only HEAD~1 HEAD": ok("src/foo.ts\nsrc/bar.ts\n"),
      "bun run build": ok("Build complete"),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(true);
    expect(result.upToDate).toBe(false);
    expect(result.depsChanged).toBe(false);
    expect(result.installOutput).toBeUndefined();
    expect(result.buildOutput).toContain("Build complete");
  });

  it("runs bun install when root package.json changes", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Updating abc..def\n"),
      "git diff --name-only HEAD~1 HEAD": ok("package.json\nsrc/index.ts\n"),
      "bun install": ok("bun install v1.0.0\n"),
      "bun run build": ok("Build done"),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(true);
    expect(result.depsChanged).toBe(true);
    expect(result.installOutput).toContain("bun install");
    expect(result.buildOutput).toContain("Build done");
  });

  it("runs bun install when root bun.lockb changes", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Updating abc..def\n"),
      "git diff --name-only HEAD~1 HEAD": ok("bun.lockb\n"),
      "bun install": ok("Installed\n"),
      "bun run build": ok("OK"),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(true);
    expect(result.depsChanged).toBe(true);
  });

  it("runs bun install when nested package.json changes", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Updating abc..def\n"),
      "git diff --name-only HEAD~1 HEAD": ok("packages/core/package.json\n"),
      "bun install": ok("Installed\n"),
      "bun run build": ok("OK"),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.depsChanged).toBe(true);
  });

  it("runs bun install when nested bun.lockb changes", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Updating abc..def\n"),
      "git diff --name-only HEAD~1 HEAD": ok("addons/auth/bun.lockb\n"),
      "bun install": ok("Installed\n"),
      "bun run build": ok("OK"),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.depsChanged).toBe(true);
  });

  it("respects custom remote and branch", async () => {
    const calls: string[] = [];
    const executor: ProcessExecutor = async (cmd, args, _cwd) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git" && args[0] === "pull") return ok("Already up to date.\n");
      return ok("OK");
    };

    const builder = new DeployBuilder({
      repoDir: REPO_DIR,
      remote: "upstream",
      branch: "release",
      executor,
      logger: silentLogger,
    });
    await builder.build();

    expect(calls[0]).toBe("git pull upstream release");
  });

  it("respects custom buildScript", async () => {
    const calls: string[] = [];
    const executor: ProcessExecutor = async (cmd, args, _cwd) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git" && args[0] === "pull") return ok("Already up to date.\n");
      return ok("OK");
    };

    const builder = new DeployBuilder({
      repoDir: REPO_DIR,
      buildScript: "build:production",
      executor,
      logger: silentLogger,
    });
    await builder.build();

    expect(calls).toContain("bun run build:production");
  });

  it("includes durationMs in successful result", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Already up to date.\n"),
      "bun run build": ok("OK"),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Failure paths ─────────────────────────────────────────────────────────

describe("DeployBuilder — failure paths", () => {
  it("returns failed result when git pull exits non-zero", async () => {
    const executor = makeExecutor({
      "git pull origin main": fail("fatal: unable to access remote", 128),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(false);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("git pull failed");
    expect(result.error).toContain("128");
  });

  it("returns failed result when bun install exits non-zero", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Updating abc..def\n"),
      "git diff --name-only HEAD~1 HEAD": ok("package.json\n"),
      "bun install": fail("error: package resolution failed", 1),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(false);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("bun install failed");
    expect(result.depsChanged).toBe(true);
  });

  it("returns failed result when build script exits non-zero", async () => {
    const executor = makeExecutor({
      "git pull origin main": ok("Already up to date.\n"),
      "bun run build": fail("TypeScript error: ...", 1, ""),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(false);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("bun run build failed");
    expect(result.buildOutput).toContain("TypeScript error");
  });

  it("returns failed result when git pull executor throws", async () => {
    const executor: ProcessExecutor = async () => {
      throw new Error("network unreachable");
    };

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(false);
    expect(result.error).toContain("network unreachable");
  });

  it("returns failed result when bun install executor throws", async () => {
    let callCount = 0;
    const executor: ProcessExecutor = async (cmd, args) => {
      callCount++;
      if (cmd === "git" && args[0] === "pull") return ok("Updating abc..def\n");
      if (cmd === "git" && args[0] === "diff") return ok("package.json\n");
      throw new Error("bun binary missing");
    };

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.success).toBe(false);
    expect(result.error).toContain("bun install error");
    expect(callCount).toBeGreaterThan(0);
  });

  it("proceeds with build even when git diff fails (skips install)", async () => {
    const executor: ProcessExecutor = async (cmd, args) => {
      if (cmd === "git" && args[0] === "pull") return ok("Updating abc..def\n");
      if (cmd === "git" && args[0] === "diff") throw new Error("fatal: no commits yet");
      if (cmd === "bun" && args[0] === "run") return ok("Build OK");
      throw new Error(`Unexpected: ${[cmd, ...args].join(" ")}`);
    };

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    // Install skipped, build still ran
    expect(result.success).toBe(true);
    expect(result.depsChanged).toBe(false);
    expect(result.installOutput).toBeUndefined();
  });
});

// ── Timeout path ──────────────────────────────────────────────────────────

describe("DeployBuilder — timeout", () => {
  it("returns failed result when git pull exceeds timeoutMs", async () => {
    const builder = new DeployBuilder({
      repoDir: REPO_DIR,
      timeoutMs: 50,
      executor: slowExecutor(500),
      logger: silentLogger,
    });

    const result = await builder.build();

    expect(result.success).toBe(false);
    expect(result.phase).toBe("failed");
    expect(result.error).toMatch(/timed out/i);
  });

  it("returns failed when already past deadline before pulling", async () => {
    const executor = makeExecutor({});
    const builder = new DeployBuilder({
      repoDir: REPO_DIR,
      timeoutMs: 0,
      executor,
      logger: silentLogger,
    });

    const result = await builder.build();

    expect(result.success).toBe(false);
    expect(result.error).toContain("pulling");
  });
});

// ── gitPullOutput ─────────────────────────────────────────────────────────

describe("DeployBuilder — gitPullOutput", () => {
  it("combines stdout and stderr from git pull", async () => {
    const executor = makeExecutor({
      "git pull origin main": {
        stdout: "Updating abc..def\n",
        stderr: "warning: x\n",
        exitCode: 0,
      },
      "git diff --name-only HEAD~1 HEAD": ok(""),
      "bun run build": ok("OK"),
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.gitPullOutput).toContain("Updating abc..def");
    expect(result.gitPullOutput).toContain("warning: x");
  });

  it("includes stderr from git pull in error message on failure", async () => {
    const executor = makeExecutor({
      "git pull origin main": { stdout: "", stderr: "fatal: repo not found", exitCode: 128 },
    });

    const builder = new DeployBuilder({ repoDir: REPO_DIR, executor, logger: silentLogger });
    const result = await builder.build();

    expect(result.error).toContain("repo not found");
  });
});
