/**
 * cap-dry-run — REAL subprocess smoke test (Spec 70 P3).
 *
 * Proves the hardened runner's safety + outcome mapping by actually spawning the
 * sandboxed child. The behavioural tests run ONLY where an OS sandbox that denies
 * network egress is available (macOS `sandbox-exec`, Linux `bwrap`); on
 * a host without one they are skipped (the runner there correctly fails closed,
 * which the always-on tests cover). Nothing here ever runs untrusted code outside
 * a sandbox.
 */

import { describe, expect, test } from "bun:test";
import {
  buildSandboxArgv,
  createSubprocessDryRunner,
  detectSandboxStrategy,
  isSandboxStrategyUsable,
  type SandboxEnv,
} from "../src/index";

const TARGET = "action" as const;

/** Build generated source whose `defineAction` handler has the given body. LinchKit
 * handlers take a single `ctx`, with inputs at `ctx.input`. */
function sourceFor(handlerBody: string): string {
  return [
    'import { defineAction } from "@linchkit/core";',
    "export const generated = defineAction({",
    '  name: "dry_run_probe",',
    "  handler: async (ctx) => {",
    `    ${handlerBody}`,
    "  },",
    "});",
    "",
  ].join("\n");
}

function job(source: string, input: unknown = {}, timeoutMs = 5_000) {
  return {
    source,
    target: TARGET,
    changeName: "dry_run_probe",
    input,
    inputCaseId: "case-0",
    limits: { timeoutMs, memoryBytes: 256 * 1024 * 1024 },
  };
}

// A SandboxEnv that reports no usable sandbox — drives the fail-closed path
// deterministically on any host.
const NO_SANDBOX_ENV: SandboxEnv = {
  which: () => null,
  getEnv: () => undefined,
  platform: "darwin",
};

describe("createSubprocessDryRunner — fail closed + detection (host-independent)", () => {
  test("no OS sandbox available → infra_error, runs nothing, never blocks", async () => {
    const runner = createSubprocessDryRunner({ sandboxEnv: NO_SANDBOX_ENV });
    const outcome = await runner.dryRun(job(sourceFor("return { ok: true };")));
    expect(outcome.status).toBe("infra_error");
    expect(outcome.changeName).toBe("dry_run_probe");
    expect(outcome.inputCaseId).toBe("case-0");
    expect(outcome.error ?? "").toContain("failing closed");
  });

  test("detectSandboxStrategy: darwin needs sandbox-exec; linux needs bwrap; else null", () => {
    const mk = (over: Partial<SandboxEnv>): SandboxEnv => ({
      which: () => null,
      getEnv: () => undefined,
      platform: "linux",
      ...over,
    });
    expect(
      detectSandboxStrategy(mk({ platform: "darwin", which: () => "/usr/bin/sandbox-exec" })),
    ).toBe("sandbox-exec");
    expect(detectSandboxStrategy(mk({ platform: "darwin", which: () => null }))).toBeNull();
    expect(
      detectSandboxStrategy(
        mk({ platform: "linux", which: (b) => (b === "bwrap" ? "/usr/bin/bwrap" : null) }),
      ),
    ).toBe("bwrap");
    // `unshare` alone does NOT confine filesystem writes → we fail closed, not run it.
    expect(
      detectSandboxStrategy(
        mk({ platform: "linux", which: (b) => (b === "unshare" ? "/usr/bin/unshare" : null) }),
      ),
    ).toBeNull();
    expect(detectSandboxStrategy(mk({ platform: "linux", which: () => null }))).toBeNull();
    // Explicit container opt-in wins on any platform.
    expect(
      detectSandboxStrategy(
        mk({
          platform: "win32",
          getEnv: (k) => (k === "LINCHKIT_DRYRUN_TRUST_CONTAINER" ? "1" : undefined),
        }),
      ),
    ).toBe("trusted-container");
  });

  test("isSandboxStrategyUsable: a present-but-broken sandbox-exec is rejected", () => {
    // bwrap / trusted-container are usable when present (no probe).
    expect(isSandboxStrategyUsable("bwrap", () => ({ exitCode: 1 }))).toBe(true);
    expect(isSandboxStrategyUsable("trusted-container", () => ({ exitCode: 1 }))).toBe(true);
    // sandbox-exec is probed: exit 0 → usable, non-zero or throw → fail closed.
    expect(isSandboxStrategyUsable("sandbox-exec", () => ({ exitCode: 0 }))).toBe(true);
    expect(isSandboxStrategyUsable("sandbox-exec", () => ({ exitCode: 1 }))).toBe(false);
    expect(
      isSandboxStrategyUsable("sandbox-exec", () => {
        throw new Error("sandbox_apply: Operation not permitted");
      }),
    ).toBe(false);
  });

  test("buildSandboxArgv: sandbox-exec wraps with the profile; bwrap unshares the net", () => {
    const exec = buildSandboxArgv({
      strategy: "sandbox-exec",
      childArgv: ["/bin/bun", "x.ts"],
      tempDir: "/tmp/d",
      profilePath: "/tmp/d/p.sb",
    });
    expect(exec.slice(0, 4)).toEqual(["sandbox-exec", "-f", "/tmp/d/p.sb", "/bin/bun"]);
    const bwrap = buildSandboxArgv({
      strategy: "bwrap",
      childArgv: ["/bin/bun"],
      tempDir: "/tmp/d",
    });
    expect(bwrap[0]).toBe("bwrap");
    expect(bwrap).toContain("--unshare-net");
  });
});

// ── Behavioural tests — require a real, USABLE OS sandbox on this host ─────────
const DETECTED = detectSandboxStrategy();
const HAS_SANDBOX = DETECTED !== null && isSandboxStrategyUsable(DETECTED);
const itReal = HAS_SANDBOX ? test : test.skip;
// The memory guard sums RSS across the whole process tree, so it covers the descendant
// bun under bwrap too. We assert `oom` deterministically only on the strategies this
// host can actually exercise (sandbox-exec / trusted-container); the bwrap path is left
// lenient since it cannot be run here.
const RSS_GUARD_EFFECTIVE = DETECTED === "sandbox-exec" || DETECTED === "trusted-container";

describe(`createSubprocessDryRunner — real sandboxed execution (${HAS_SANDBOX ? "active" : "SKIPPED: no host sandbox"})`, () => {
  itReal("a clean handler returning a value → passed", async () => {
    const runner = createSubprocessDryRunner();
    const outcome = await runner.dryRun(
      job(sourceFor("return { ok: true, n: ctx.input.qty };"), { qty: 7 }),
    );
    expect(outcome.status).toBe("passed");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  itReal(
    "a side-effect-style handler with no declared output returning void → passed",
    async () => {
      const runner = createSubprocessDryRunner();
      // LinchKit `output` is optional; a handler that declares no output and returns nothing
      // runs fine in the real engine, so the dry-run must NOT stamp a content failure.
      const outcome = await runner.dryRun(job(sourceFor("const x = ctx.input.qty;"), { qty: 1 }));
      expect(outcome.status).toBe("passed");
    },
  );

  itReal(
    "a handler that DECLARES an output contract but returns undefined → malformed_output",
    async () => {
      const runner = createSubprocessDryRunner();
      // When the definition declares a non-empty `output`, a void return IS a content
      // failure — it promised a value and produced none.
      const source = [
        'import { defineAction } from "@linchkit/core";',
        "export const generated = defineAction({",
        '  name: "dry_run_probe",',
        "  output: { ok: { type: 'boolean' } },",
        "  handler: async (ctx) => { const x = ctx.input.qty; },",
        "});",
        "",
      ].join("\n");
      const outcome = await runner.dryRun({
        source,
        target: TARGET,
        changeName: "dry_run_probe",
        input: { qty: 1 },
        inputCaseId: "case-0",
        limits: { timeoutMs: 5_000, memoryBytes: 256 * 1024 * 1024 },
      });
      expect(outcome.status).toBe("malformed_output");
    },
  );

  itReal("a handler reading real ctx fields (input/tenantId/logger) → passed", async () => {
    const runner = createSubprocessDryRunner();
    // Reading the standard read-only context surface must NOT be a false failure.
    const outcome = await runner.dryRun(
      job(
        sourceFor(
          'ctx.logger.info("hi"); return { tenant: ctx.tenantId, qty: ctx.input.qty, who: ctx.actor.id };',
        ),
        { qty: 3 },
      ),
    );
    expect(outcome.status).toBe("passed");
  });

  itReal("a handler reading ctx.actor.groups → passed (full actor shape)", async () => {
    const runner = createSubprocessDryRunner();
    // A permission-aware handler inspecting ctx.actor.groups must not falsely throw.
    const outcome = await runner.dryRun(
      job(sourceFor("return { admin: ctx.actor.groups.includes('admin'), who: ctx.actor.id };")),
    );
    expect(outcome.status).toBe("passed");
  });

  itReal("a handler reading ctx.meta.get(...) → passed (ExecutionMeta shim)", async () => {
    const runner = createSubprocessDryRunner();
    const outcome = await runner.dryRun({
      source: sourceFor(
        "if (!ctx.meta.has('trace')) throw new Error('meta.has broken'); return { t: ctx.meta.get('trace') };",
      ),
      target: TARGET,
      changeName: "dry_run_probe",
      input: {},
      inputCaseId: "case-0",
      metadata: { trace: "abc-123" },
      limits: { timeoutMs: 5_000, memoryBytes: 256 * 1024 * 1024 },
    });
    expect(outcome.status).toBe("passed");
  });

  itReal("a handler that throws → threw, raw message withheld (no exfil channel)", async () => {
    const runner = createSubprocessDryRunner();
    // A thrown message is attacker-controlled, so it must NOT be surfaced (it could be
    // the contents of a file the handler read). The status still classifies the failure.
    const outcome = await runner.dryRun(
      job(sourceFor('throw new Error("SECRET-THROW-MARKER-9999");')),
    );
    expect(outcome.status).toBe("threw");
    expect(JSON.stringify(outcome)).not.toContain("SECRET-THROW-MARKER");
  });

  itReal(
    "a multi-export module runs the def matching changeName, NOT the first export",
    async () => {
      const runner = createSubprocessDryRunner();
      // A clean helper is exported FIRST; the actual change throws. Selecting by name
      // must run the change (→ threw), never the helper that would falsely pass.
      const source = [
        'import { defineAction } from "@linchkit/core";',
        'export const aaa_helper = defineAction({ name: "aaa_helper", handler: async () => ({ ok: true }) });',
        'export const target = defineAction({ name: "deduct_inventory", handler: async () => { throw new Error("real-target-ran"); } });',
        "",
      ].join("\n");
      const outcome = await runner.dryRun({
        source,
        target: "action",
        changeName: "deduct_inventory",
        input: {},
        inputCaseId: "case-0",
        limits: { timeoutMs: 5_000, memoryBytes: 256 * 1024 * 1024 },
      });
      // The throwing target → "threw"; had the helper (exported first) wrongly run, it
      // would have "passed". So the status alone proves the by-name selection.
      expect(outcome.status).toBe("threw");
    },
  );

  itReal("untrusted top-level code cannot forge a passed verdict", async () => {
    const runner = createSubprocessDryRunner();
    // Module top-level code (runs at import, before the handler) tries every forge
    // vector: mutate the intrinsics the harness serialises with, write a fake "passed"
    // to the old fixed result name, then exit early. The harness snapshots intrinsics
    // and uses a random + argv-scrubbed result path with neutralised exits, so the
    // actual (throwing) handler's verdict must win.
    const source = [
      'import { defineAction } from "@linchkit/core";',
      'try { JSON.stringify = () => "{\\"status\\":\\"passed\\"}"; } catch (e) {}',
      "try { globalThis.Proxy = function () { return {}; }; } catch (e) {}",
      "try { Object.values = () => []; } catch (e) {}",
      'try { const fs = await import("node:fs"); fs.writeFileSync("__dryrun_result.json", "{\\"status\\":\\"passed\\"}"); } catch (e) {}',
      "try { process.exit(0); } catch (e) {}",
      "try { Bun.exit(0); } catch (e) {}",
      'export const evil = defineAction({ name: "dry_run_probe", handler: async () => { throw new Error("should-not-pass"); } });',
      "",
    ].join("\n");
    const outcome = await runner.dryRun({
      source,
      target: TARGET,
      changeName: "dry_run_probe",
      input: {},
      inputCaseId: "case-0",
      limits: { timeoutMs: 5_000, memoryBytes: 256 * 1024 * 1024 },
    });
    expect(outcome.status).not.toBe("passed");
  });

  itReal("prototype-method pollution cannot suppress a forbidden side-effect record", async () => {
    const runner = createSubprocessDryRunner();
    // Untrusted top-level replaces the PROTOTYPE methods the recording path uses
    // (push/has/split/hasOwnProperty) — a higher-order forge than mutating the
    // intrinsics. The harness uncurried these BEFORE importing the source, so a
    // swallowed forbidden `ctx.create` is still RECORDED → forbidden_side_effect,
    // never the `{ ok: true }` the handler returns.
    const source = [
      'import { defineAction } from "@linchkit/core";',
      "try { Array.prototype.push = function () { return 0; }; } catch (e) {}",
      "try { Set.prototype.has = function () { return true; }; } catch (e) {}",
      "try { String.prototype.split = function () { return []; }; } catch (e) {}",
      "try { Object.prototype.hasOwnProperty = function () { return false; }; } catch (e) {}",
      'export const evil = defineAction({ name: "dry_run_probe", handler: async (ctx) => { try { await ctx.create("order", {}); } catch (e) {} return { ok: true }; } });',
      "",
    ].join("\n");
    const outcome = await runner.dryRun({
      source,
      target: TARGET,
      changeName: "dry_run_probe",
      input: {},
      inputCaseId: "case-0",
      limits: { timeoutMs: 5_000, memoryBytes: 256 * 1024 * 1024 },
    });
    expect(outcome.status).toBe("forbidden_side_effect");
  });

  itReal("an ambiguous multi-export module with no name match → malformed_output", async () => {
    const runner = createSubprocessDryRunner();
    const source = [
      'import { defineAction } from "@linchkit/core";',
      'export const one = defineAction({ name: "one", handler: async () => ({ ok: true }) });',
      'export const two = defineAction({ name: "two", handler: async () => ({ ok: true }) });',
      "",
    ].join("\n");
    const outcome = await runner.dryRun({
      source,
      target: "action",
      changeName: "neither",
      input: {},
      inputCaseId: "case-0",
      limits: { timeoutMs: 5_000, memoryBytes: 256 * 1024 * 1024 },
    });
    expect(outcome.status).toBe("malformed_output");
  });

  itReal("an infinite loop → timeout (killed)", async () => {
    const runner = createSubprocessDryRunner();
    const outcome = await runner.dryRun(job(sourceFor("while (true) {}"), {}, 1_200));
    expect(outcome.status).toBe("timeout");
  });

  itReal(
    "a handler that spawns a lingering child + loops → timeout, reaped, call returns promptly",
    async () => {
      const runner = createSubprocessDryRunner();
      // The handler starts a long-lived child, then loops forever. The child is in the
      // dry-run's process group (`detached`), so the timeout kills the whole tree — the
      // call must return near the 800ms timeout, NOT wait the ~9s the `sleep` imposes.
      const started = Date.now();
      const outcome = await runner.dryRun(
        job(
          sourceFor(
            'Bun.spawn(["sleep", "9"], { stdout: "inherit", stderr: "inherit" }); while (true) {}',
          ),
          {},
          800,
        ),
      );
      const elapsed = Date.now() - started;
      expect(outcome.status).toBe("timeout");
      expect(elapsed).toBeLessThan(4_000);
    },
  );

  itReal("a handler that allocates past the memory limit → oom (RSS guard)", async () => {
    const runner = createSubprocessDryRunner();
    const outcome = await runner.dryRun({
      source: sourceFor(
        "const big = new Uint8Array(220 * 1024 * 1024); big.fill(7); while (true) {}",
      ),
      target: TARGET,
      changeName: "dry_run_probe",
      input: {},
      inputCaseId: "case-0",
      limits: { timeoutMs: 5_000, memoryBytes: 128 * 1024 * 1024 },
    });
    if (RSS_GUARD_EFFECTIVE) {
      expect(outcome.status).toBe("oom");
    } else {
      // Under bwrap the bomb is not sampled directly; the wall-clock timeout backstops.
      expect(["oom", "timeout"]).toContain(outcome.status);
    }
  });

  itReal("the untrusted child's stdout/stderr is NOT surfaced in the outcome", async () => {
    const runner = createSubprocessDryRunner();
    // A handler that reads a host file and prints it must not be able to exfiltrate it
    // through the returned outcome: captured output is the channel, so we discard it.
    const outcome = await runner.dryRun(
      job(
        sourceFor(
          'console.log("EXFIL-MARKER-12345"); console.error("EXFIL-ERR-678"); return { ok: true };',
        ),
      ),
    );
    expect(outcome.status).toBe("passed");
    expect(JSON.stringify(outcome)).not.toContain("EXFIL-MARKER");
    expect(JSON.stringify(outcome)).not.toContain("EXFIL-ERR");
  });

  itReal("a handler that fetches the network → threw (egress DENIED, nothing leaked)", async () => {
    const runner = createSubprocessDryRunner();
    const outcome = await runner.dryRun(
      job(
        sourceFor(
          'const r = await fetch("http://example.com", { signal: AbortSignal.timeout(3000) }); return { leaked: r.status };',
        ),
      ),
    );
    // The sandbox blocks egress, so the handler's fetch fails — it must NEVER come
    // back "passed" with a real status code.
    expect(outcome.status).not.toBe("passed");
    expect(["threw", "timeout"]).toContain(outcome.status);
  });

  itReal(
    "a handler that reaches for ctx I/O → forbidden_side_effect (recorded, not performed)",
    async () => {
      const runner = createSubprocessDryRunner();
      const outcome = await runner.dryRun(
        job(sourceFor('await ctx.create("order", {}); return { ok: true };')),
      );
      expect(outcome.status).toBe("forbidden_side_effect");
      const effects = outcome.attemptedSideEffects ?? [];
      expect(effects.some((e) => e.detail.includes("ctx.create"))).toBe(true);
      // P4 kind inference: ctx.create → db_write (Spec 70 P4).
      expect(effects.find((e) => e.detail.includes("ctx.create"))?.kind).toBe("db_write");
    },
  );

  itReal("ctx.query → db_read kind (P4 kind inference)", async () => {
    const runner = createSubprocessDryRunner();
    const outcome = await runner.dryRun(
      job(sourceFor('await ctx.query("order", {}); return { ok: true };')),
    );
    expect(outcome.status).toBe("forbidden_side_effect");
    const effects = outcome.attemptedSideEffects ?? [];
    expect(effects.find((e) => e.detail.includes("ctx.query"))?.kind).toBe("db_read");
  });

  itReal(
    "a handler that SWALLOWS a forbidden side-effect error still → forbidden_side_effect",
    async () => {
      const runner = createSubprocessDryRunner();
      // Catching the shim error must not let the attempt be reported as a clean pass.
      const outcome = await runner.dryRun(
        job(sourceFor('try { await ctx.create("order", {}); } catch (e) {} return { ok: true };')),
      );
      expect(outcome.status).toBe("forbidden_side_effect");
    },
  );

  itReal(
    "a handler that writes outside the sandbox → blocked, the sentinel never exists",
    async () => {
      const runner = createSubprocessDryRunner();
      // A path under this repo worktree — outside every dir the profile allows writes.
      const sentinel = `${process.cwd()}/__dryrun_sentinel_${Date.now()}.txt`;
      const outcome = await runner.dryRun(
        job(sourceFor("await Bun.write(ctx.input.sentinel, 'leaked'); return { ok: true };"), {
          sentinel,
        }),
      );
      // The write is denied → the handler throws (or it is otherwise not "passed").
      expect(outcome.status).not.toBe("passed");
      expect(await Bun.file(sentinel).exists()).toBe(false);
    },
  );

  itReal(
    "a handler that writes to a shared temp path (/tmp) → blocked, no persistent leak",
    async () => {
      const runner = createSubprocessDryRunner();
      // A shared temp path OUTSIDE this run's dir. The profile used to allow all of
      // /private/tmp; writes there must now be denied so nothing persists between runs.
      const sentinel = `/tmp/__dryrun_leak_${Date.now()}.txt`;
      const outcome = await runner.dryRun(
        job(sourceFor("await Bun.write(ctx.input.sentinel, 'leaked'); return { ok: true };"), {
          sentinel,
        }),
      );
      expect(outcome.status).not.toBe("passed");
      expect(await Bun.file(sentinel).exists()).toBe(false);
    },
  );
});
