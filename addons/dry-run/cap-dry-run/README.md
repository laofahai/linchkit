# @linchkit/cap-dry-run

Execution dry-run runner — **Spec 70 P3**. Implements the core `ExecutionDryRunProvider`
seam by running AI-generated handler source in a **hardened, network-denied Bun
subprocess** and returning a `DryRunOutcome`.

Core stays execution-free: it declares the seam (Spec 70 P2); this capability runs
the untrusted code in a sandbox.

## Safety posture

Each `dryRun` call runs one change against one synthetic input in a throwaway temp
dir, then cleans up. Layered defense:

- **OS sandbox denies network egress AND confines writes** — `sandbox-exec` (macOS),
  `bwrap` (Linux, read-only root + per-run writable bind), or a declared `--network none`
  container (`LINCHKIT_DRYRUN_TRUST_CONTAINER=1`). `unshare` alone is rejected: it denies
  the network but leaves the host filesystem writable. The detected primitive is also
  **probed for usability** (a present-but-broken `sandbox-exec` is treated as absent). No
  usable sandbox → **fail closed**: report `infra_error`, run nothing.
- **No output exfiltration channel** — the child's stdout/stderr are **discarded**, never
  returned. The verdict comes only from the structured result the harness writes, so a
  handler that reads a host file and prints it cannot surface its contents in the outcome.
- **Credential reads blocked** — common secret dirs are denied (`sandbox-exec` deny-read
  of `~/.ssh`/`~/.aws`/… ; `bwrap` hides `/home` + `/root`). A full deny-default read
  sandbox is impractical for a runtime, so airtight read-isolation is the microvm
  runner tier (see *Runner tiers* below — the container sees only the image + the
  per-run temp dir).
- **Minimal env** — no secrets (no `DATABASE_URL`/keys); `HOME`/`TMPDIR` point at the
  throwaway dir.
- **Shimmed `@linchkit/core`** — `define*()` resolves to a fake; the real DB/provider
  wiring never loads. The change to dry-run is selected by name, so a multi-export module
  never silently runs the wrong definition. The handler runs against a faithful
  `ActionContext`: real read-only fields (`input`/`logger`/`actor`/`tenantId`/an
  `ExecutionMeta` shim) so valid handlers don't falsely fail, while every I/O method
  (`create`/`query`/`update`/`delete`/`execute`/`emit`/`ai`/…) records a
  `forbidden_side_effect` and throws.
- **Hard timeout** — the child runs as a process-group leader (`detached`), so past
  `limits.timeoutMs` the whole group is killed → `timeout`, reaping any subprocess the
  handler spawned.
- **Memory cap** — two layers (Spec 70 P5):
  - *OS-enforced (Linux)*: when `prlimit` is available, the spawn is prefixed with
    `prlimit --data=<memoryBytes> --` OUTSIDE the sandbox wrapper — the rlimit inherits
    across exec into the sandboxed bun and every descendant. `RLIMIT_DATA` was chosen
    over `RLIMIT_AS` (a JS engine reserves multi-GiB virtual address space at startup,
    so an `--as` cap would stop the child from launching) and over a `sh -c 'ulimit …'`
    wrapper (no shell ever touches the argv). On the microvm tier the cgroup
    `--memory` flag is the OS-enforced cap instead.
  - *RSS-polling guard (all platforms, defense in depth)*: the child process tree's RSS
    is sampled against `limits.memoryBytes`; a runaway allocation is killed → `oom`.
    macOS has no rlimit-style RSS enforcement (`sandbox-exec` cannot cap memory), so
    there the poll is the only memory bound (the timeout still backstops).

With network denied, captured output discarded, an empty env, and a shimmed core, a
file read cannot be exfiltrated and the DB cannot be reached. File **writes** are confined to the temp
dir (macOS profile / bwrap bind).

**Verdict integrity.** The generated code shares the child's JS realm with the harness,
so the harness snapshots the intrinsics it relies on (`JSON.stringify`, `Object.values`,
`Proxy`, …) and pre-builds the context **before** importing the source, scrubs the
randomly named result path from `argv`, neutralises the exit functions, and writes the
verdict with the snapshots — a top-level forge attempt (fake `passed` + early exit, or
mutating those globals) cannot win. Airtight verdict integrity against a determined
same-realm adversary is the kernel-boundary (microvm) tier's job. The dry-run is
warn-only and human-gated, so its signal is advisory in P3.

## Runner tiers (Spec 70 §4)

`createDryRunner({ runner })` selects the isolation tier; the launcher (harness files
and args) is IDENTICAL in both — only the spawn wrapper differs:

- **`"subprocess"`** (default) — the hardened OS-sandboxed Bun child described above,
  plus the Linux `prlimit --data` rlimit when available. Wrapper ordering (outermost →
  innermost): `prlimit` → sandbox (`bwrap`/`sandbox-exec`/bare-in-trusted-container) →
  `bun` harness.
- **`"microvm"`** — the escalation tier for hostile multi-tenant deployments: the same
  launcher runs behind a gVisor KERNEL boundary via the production runsc integration,
  `docker run --runtime=runsc --network=none --read-only --cap-drop=ALL
  --memory=<limits.memoryBytes> -v <tempDir>:<tempDir> <image> bun …`. Requires `docker`
  AND `runsc` on PATH, and the daemon must list a `runsc` runtime (probed via
  `docker info`). The per-run temp dir is the only writable bind, mounted at the same
  absolute path so the result file round-trips; `microvmImage` (default `oven/bun:1`)
  supplies the in-container `bun`. A direct `runsc do` is deliberately NOT supported:
  it overlays the host root, discarding the harness's result file with the sandbox.

  **Fail closed, never fall back:** when `runner: "microvm"` is configured and no
  usable mechanism exists, the runner reports `infra_error`
  ("microvm runner unavailable … failing closed; no untrusted code was run") — it
  NEVER silently degrades to the subprocess tier, which would report a weaker
  boundary as the stronger one.

## Usage

```ts
import { createDryRunner } from "@linchkit/cap-dry-run";

const runner = createDryRunner(); // or { runner: "microvm" } on a gVisor host
const outcome = await runner.dryRun({
  source,            // AI-materialized TypeScript (a defineAction module)
  target: "action",
  changeName: "deduct_inventory",
  input: { qty: 5 }, // synthetic input
  inputCaseId: "case-0",
  limits: { timeoutMs: 5000, memoryBytes: 256 * 1024 * 1024 },
});
// outcome.status ∈ passed | threw | timeout | oom | forbidden_side_effect |
//                  malformed_output | infra_error
```

`createSubprocessDryRunner` remains exported as a back-compat alias of
`createDryRunner` (same options, including `runner`).

A P3 follow-up wires this provider into the async materialize path to stamp the
durable `dryRunStatus` that validation Phase 5 reads (Spec 70 §5).
