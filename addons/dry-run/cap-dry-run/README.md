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
  sandbox is impractical for a runtime, so airtight read-isolation is the P5 microVM tier.
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
- **Memory guard (best-effort)** — the child's RSS is sampled against `limits.memoryBytes`;
  a runaway allocation is killed → `oom`. This sees the handler's process directly on
  `sandbox-exec`/trusted-container; under `bwrap` the launcher is sampled, so a precise,
  descendant-inclusive cap is the P5 cgroup/microVM tier (the timeout still backstops).

With network denied, captured output discarded, an empty env, and a shimmed core, a
file read cannot be exfiltrated and the DB cannot be reached. File **writes** are confined to the temp
dir (macOS profile / bwrap bind).

**Verdict integrity.** The generated code shares the child's JS realm with the harness,
so the harness snapshots the intrinsics it relies on (`JSON.stringify`, `Object.values`,
`Proxy`, …) and pre-builds the context **before** importing the source, scrubs the
randomly named result path from `argv`, neutralises the exit functions, and writes the
verdict with the snapshots — a top-level forge attempt (fake `passed` + early exit, or
mutating those globals) cannot win. Airtight verdict integrity against a determined
same-realm adversary, a precise descendant-inclusive memory cap, and a kernel-level
boundary (gVisor/Firecracker microVM) are the Spec 70 P5 hardening tier. The dry-run is
warn-only and human-gated, so its signal is advisory in P3.

## Usage

```ts
import { createSubprocessDryRunner } from "@linchkit/cap-dry-run";

const runner = createSubprocessDryRunner();
const outcome = await runner.dryRun({
  source,            // AI-materialized TypeScript (a defineAction module)
  target: "action",
  changeName: "deduct_inventory",
  input: { qty: 5 }, // synthetic input
  inputCaseId: "case-0",
  limits: { timeoutMs: 5000, memoryBytes: 256 * 1024 * 1024 },
});
// outcome.status ∈ passed | threw | timeout | forbidden_side_effect |
//                  malformed_output | infra_error
```

A P3 follow-up wires this provider into the async materialize path to stamp the
durable `dryRunStatus` that validation Phase 5 reads (Spec 70 §5).
