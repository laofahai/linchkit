# Generated-Code Execution Dry-Run Sandbox

> This spec designs the **execution-based dry-run** of AI-generated code — the deliberately-deferred last gap of the evolution "说→有" loop. It is the execution companion to:
> - **Spec 55 — Evolution System** (§7.7 G5 code materialization — *how* AI source is generated and attached to a Proposal)
> - **Spec 09 — Proposal & Validation** (the draft→validated→approved→committed→deployed pipeline this phase plugs into)
> - **Spec 27 — AI Security** (prompt-injection defense, output validation — the threat surface this hardens)
> - **Spec 39 — Execution Contract** (what an Action handler is allowed to be / do)
>
> Without this spec, validation Phase 4 can only check AI-generated source **statically** — it never finds out whether the code actually *runs*. A handler can pass syntax (Phase 2), compatibility (Phase 3), and the generated-source contract (Phase 4) and still throw on realistic input, return malformed output, loop forever, or attempt a forbidden side effect (DB write, network egress, secret read). This spec defines how to run that code in a locked-down sandbox and feed the result back into the same warn/block gating — **opt-in, infra-gated, and never a side effect of ordinary validation**.
>
> Tracking milestones: M6 (P1 design + P2 seam), M7 (P3 subprocess runner + P4 durable signal/UI), M7+ (P5 gating + hardening tier).

**Status: Draft (design only — no execution implemented).**

## 1. Background and Motivation

### 1.1 The current gap

The evolution loop materializes AI-generated source for the irreducibly-code parts of a Proposal change (today an `ActionDefinition.handler` body) via `materializeProposalChanges` (Spec 55 §7.7, G5). That source is then validated **execution-free**:

| Phase | File | Checks | Executes code? |
|---|---|---|---|
| 1 — Static | `validation-phase1.ts` | structural / required-field | no |
| 2 — Build | `code-quality-gate.ts` (`Bun.Transpiler`) | the source parses / transpiles | no |
| 3 — Compatibility | `validation-phase3.ts` | no breaking refs to existing entities/actions | no |
| 4 — Generated-source contract | `validation-phase4.ts` | right `define*()` call, declared name referenced, `@linchkit/core` import; FAILED-materialization changes flagged | **no — execution-free by design** |

`validation-phase4.ts` says so explicitly:

> A true execution-based dry-run (running a generated handler against sample/historical data) requires a locked-down sandbox and is intentionally OUT OF SCOPE here — deferred to a separate, sandbox-gated step so untrusted AI code is never run as a side effect of validation.

This spec **is** that separate step.

### 1.2 What static checks cannot catch

A change can clear Phases 1–4 and still be wrong at runtime:

- **Throws on realistic input** — null-deref, bad assumption about input shape, missing `await`.
- **Malformed output** — returns the wrong shape / violates the action's declared output contract.
- **Non-terminating** — an unbounded loop or an `await` that never resolves.
- **Forbidden side effect** — the handler tries to write the real DB, read `process.env`, open a socket, or touch the filesystem. Static heuristics see `defineAction(...)` and a name; they do not see intent.
- **Prompt-injection payload** — a malicious string smuggled into the ontology/context (Spec 27) steers generation toward exfiltration. Static contract checks pass; behavior is hostile.

The dry-run is the only validation layer that observes *behavior*. It is a strong signal — and, because executing untrusted code is itself a risk, the most security-sensitive one to build.

### 1.3 Why this is LinchKit-grade, not nice-to-have

The platform's core promise is **"AI Never Modifies Production Directly — all AI-driven changes go through Proposal → Validation → Approval."** Validation that can only read code, never run it, is the weakest link in that promise. Closing it — safely — is what lets a reviewer trust "this generated handler works" instead of "this generated handler parses."

## 2. Non-Goals

- **NOT auto-on.** Running untrusted AI code is a deliberate, configured action — never a silent side effect of opening or validating a Proposal. Default OFF in every environment, including production.
- **NOT a replacement for human review or the graduation PR gate.** It is an *additional* signal feeding the existing double-human-gated flow.
- **NOT a general code-execution service.** Scoped to materializable changes (today: `action`) carrying valid `generatedSource` inside a *draft* Proposal.
- **NOT production-traffic execution.** The dry-run runs against synthetic (and optionally redacted historical) inputs in an isolated sandbox — never against live data, live tenants, or real side-effecting dependencies.

## 3. Threat Model

AI-generated handler source is **untrusted input**. Assume it may — by model error or via prompt injection in the ontology/context — attempt to:

| Threat | Example |
|---|---|
| Read secrets | `process.env.DATABASE_URL`, config keys, tokens |
| Mutate data | write/delete in the real DB or filesystem |
| Exfiltrate | `fetch()` to an attacker host; DNS egress |
| Exhaust resources | unbounded loop, huge allocation → DoS the host |
| Escape the sandbox | reach the host process's memory / credentials → RCE |
| Probe | enumerate files, read other tenants' data |

**Required guarantees:**

1. **No real side effects** — every I/O surface (DB, fs, network, env, clock-for-nondeterminism) is denied or replaced with an in-memory fake that *records the attempt*.
2. **Resource bounds** — hard wall-clock timeout, memory cap, CPU cap; the sandbox is killed on breach.
3. **Isolation** — a sandbox escape must not reach the host process's address space or credentials.
4. **No ambient authority** — no env vars, no filesystem handed in, and **network egress actively denied** (the child must be *unable to open a socket* — "not provided" is not enough; an OS-level network block is required).
5. **Auditable** — every dry-run records what ran, with which inputs, the outcome, resource usage, and any forbidden-op attempts.

A dry-run that cannot meet (1)–(4) MUST NOT run. **Fail closed:** if the launcher cannot enforce any of these on the host platform (no network block available, no resource limits, no isolation), it reports `skipped` (reason: sandbox-unavailable) and runs nothing — it never degrades to an unsandboxed execution.

## 4. Sandbox Technology — Options and Decision

Evaluated against the Bun-native stack (Spec 00) and the §3 threat model:

| Option | Isolation | Bun/TS-native | New native dep | Verdict |
|---|---|---|---|---|
| `node:vm` / `vm2` | **Weak** — documented escapes; vm2 unmaintained | yes | no | **Reject** for untrusted code |
| Worker thread (`new Worker`) | Medium — separate JS realm, **same process** | yes | no | Not a security boundary (shares process memory, can crash host). **Insufficient alone** |
| `isolated-vm` (V8 isolate) | Strong — separate heap + mem/time limits | runs on V8; **Bun compat unverified** | **yes (native addon)** | Strong, but native-dep approval + unverified Bun support + a V8-isolate bug still = host process compromise. **Documented alternative, not v1 default** |
| **Bun subprocess (`Bun.spawn`) + OS limits** | **Strong** — separate OS process | yes (runs TS directly) | no | A real isolation boundary at zero new deps. **Recommended v1** |
| OS container / microVM (gVisor, Firecracker) | **Strongest** — kernel boundary | yes | infra | Heaviest; right for hostile multi-tenant SaaS. **Escalation tier (P5)** |

### 4.1 Recommended v1 — hardened Bun subprocess

Run the generated TypeScript in a **separate Bun process** spawned by a hardened launcher. A separate OS process is a genuine boundary: a crash or escape is contained to the child, whose address space holds none of the host's secrets. It runs TS directly (no transpile divergence from the Phase-2 `Bun.Transpiler` gate) and needs **no new dependency**.

**Defense-in-depth layers** (each independently valuable):

1. **Dropped ambient authority** — spawn with `env: {}` (no secrets), `cwd` = a throwaway temp dir, stdin closed.
2. **No network egress (v1 requirement, fail-closed)** — the child runs inside an OS-level network-denied context: a Linux network namespace with no interfaces, macOS `sandbox-exec` with a deny-network profile, or a container with `--network none`. This is a v1 REQUIREMENT, not a deferral — a bare `Bun.spawn` does *not* block egress, so the launcher wraps the spawn in a platform-appropriate network block. If the host platform cannot enforce no-egress, the launcher **fails closed** (reports `skipped`, reason: sandbox-unavailable) rather than running with network access. The P5 microVM tier strengthens this to a kernel boundary but does not *introduce* egress denial — v1 already denies it.
3. **Filesystem** — the child sees only a read-only minimal module dir + a throwaway temp `cwd`; never the repo, `.env`, or secrets.
4. **Resource bounds** — hard wall-clock timeout (kill on breach), memory cap, CPU cap via an OS `ulimit`/cgroups wrapper the launcher abstracts (per-platform; the interface hides it).
5. **Shimmed dependencies** — the child imports a *sandbox build* of `@linchkit/core` whose data provider, logger, network, and every side-effecting API are in-memory fakes that **record** calls. A handler that tries to write the DB is *detected*, never executed for real.
6. **Capability allow-list** — the handler receives only its inputs + a fake context; any reach for a real capability is denied and recorded.

**Escalation tier (P5, hostile multi-tenant):** run the identical launcher *inside* a gVisor/Firecracker microVM for a true kernel boundary. The launcher interface is unchanged; only the spawn wrapper differs — selected by config (`runner: "subprocess" | "microvm"`).

**Why not isolated-vm as v1:** native-dep approval (CLAUDE.md gates new deps) + unverified Bun compatibility + it still shares the host process (an isolate escape compromises the host), whereas a subprocess gives a coarser but more robust OS boundary at zero new deps. Keep it documented as the fallback if per-call spawn latency proves prohibitive.

## 5. Architecture and Data Flow

**Core stays execution-free.** Core defines only the *interface* + a synchronous validation reader; the concrete runner lives in a capability (extend `cap-ai-provider`, or a new `cap-dry-run` addon — §10 Q2). This mirrors the existing `CodeGenerationProvider` injectable-seam pattern: core declares the seam, a capability supplies the impl, tests inject a fake.

**Where the async dry-run runs (durable-signal architecture).** The dry-run executes the handler in a sandbox, which is inherently asynchronous. Rather than make the whole validation pipeline async (`validateProposal` → `submitProposal` → the REST surface), the async run happens in the **already-async materialization path** (`materializeProposalChanges`) right after source is generated + build-gated; it stamps a **durable `dryRunStatus` / `dryRunOutcomes`** on the change — exactly mirroring how G5 stamps `materializationStatus` (Spec 55 §7.7, #513). Validation **Phase 5 then stays SYNCHRONOUS**: it only *reads* the persisted `dryRunStatus`, precisely as Phase 4 reads `materializationStatus: "failed"`. This keeps the entire validate/submit path synchronous and reuses the proven durable-signal + scoped-retry machinery (#513 → #517).

```
materialize (async) per materializable change:                 validate (SYNC):
  generate source → build-gate → fan out (change × input case):
    ExecutionDryRunProvider.dryRun({ source, input,                Phase 5 reads
      inputCaseId, tenantId, metadata, limits })  ─┐               change.dryRunStatus
      [capability] createSubprocessDryRunner():     │                    │
        network-denied Bun.spawn(child) →           │                    ▼
        shimmed @linchkit/core → handler(input)     │           map to PhaseResult
      collect DryRunOutcome (per case)  ────────────┤           (skipped if none) →
                                                    ▼           warn | block (per
   aggregate → STAMP durable dryRunStatus/Outcomes ───────────▶  strictExecutionDryRun)
   on the change (persisted, like materializationStatus)        infra_error → always warn
```

**Synthetic inputs** are derived from the action's declared input schema (a valid sample + a few edge cases). Optionally (§10 Q3) augmented with **historical inputs** from the execution log for that action — read-only, tenant-scoped (reuse the canonical `DataQueryOptions.tenantId` discipline), and field-masked (Spec 41) so no real PII enters the sandbox.

## 6. Data Structures (design first)

New core types (placed in a new `types/dry-run.ts` or alongside proposal types):

```ts
export type DryRunStatus =
  | "passed"               // ran to completion, well-formed output, no forbidden op
  | "threw"                // handler threw
  | "timeout"              // exceeded the wall-clock limit → killed
  | "oom"                  // exceeded the memory cap → killed
  | "forbidden_side_effect"// attempted DB/network/fs/env access (recorded, not performed)
  | "malformed_output"     // returned a shape violating the action's output contract
  | "infra_error"          // the sandbox itself failed (spawn error, missing binary,
                           // limits unenforceable) — NOT a content verdict; warns, never blocks (§7)
  | "skipped";             // not materializable / no valid source / no runner

export interface AttemptedSideEffect {
  kind: "db_write" | "db_read" | "network" | "fs" | "env" | "unknown";
  detail: string;          // e.g. "store.create('order', …)" — truncated, no payload
}

export interface DryRunOutcome {
  changeName: string;
  target: ProposalChangeTarget;
  status: DryRunStatus;
  durationMs?: number;
  peakMemoryBytes?: number;
  attemptedSideEffects?: AttemptedSideEffect[];
  error?: string;          // truncated message if it threw
  logs?: string;           // captured + truncated child stdout/stderr (stack traces,
                           // console.*) so the reviewer can debug a failing dry-run in the UI
  inputCaseId?: string;    // which synthetic/historical input produced this (repro)
}

export interface ExecutionDryRunProvider {
  /**
   * Run ONE generated change against ONE input case in the sandbox, returning that
   * case's outcome (carrying its `inputCaseId` for reproducibility). The Phase-5
   * caller fans this out over every (change × synthetic/historical input) pair —
   * each in its own isolated sandbox — and collects the per-case `DryRunOutcome[]`.
   * The change-level durable `dryRunStatus` is the WORST-CASE aggregate across that
   * change's cases (any `threw`/`timeout`/`forbidden_side_effect` dominates `passed`).
   */
  dryRun(job: {
    source: string;
    target: ProposalChangeTarget;
    changeName: string;
    input: unknown;
    inputCaseId: string;
    tenantId?: string;                   // injected into the shimmed, tenant-scoped context
    metadata?: Record<string, unknown>;  // ExecutionMeta-like fields the handler may read (Spec 65)
    limits: { timeoutMs: number; memoryBytes: number };
  }): Promise<DryRunOutcome>;
}
```

**Durable signal (composes with the existing machinery):** optionally persist `dryRunStatus?: DryRunStatus` + `dryRunOutcomes?: DryRunOutcome[]` on `ProposalChange`, exactly mirroring the `materializationStatus`/`materializationErrors` arc (#513) so:
- the `/admin/proposals` UI can render "ran clean / threw / attempted DB write" (extends `proposal-failed-changes.tsx`, #514/#516), and
- the reviewer can **re-run a single change** through the same scoped path as scoped re-materialization (#517's `changeNames`).

## 7. Validation Integration and Gating

Add **Phase 5 — Execution dry-run** to `validation-engine.ts`, after Phase 4. Phase 5 is **synchronous**: it does NOT call the runner — it READS the durable `dryRunStatus` stamped on each materializable change during materialization (§5). It reports `skipped` (the same low-regret degrade as Phase 4) when no in-scope change carries a `dryRunStatus` — i.e. when:

1. no `ExecutionDryRunProvider` was configured during materialization (nothing stamped a status), **or**
2. no materializable change has a recorded dry-run result, **or**
3. the dry-run feature (`features.executionDryRun`, consumed by the materialize path) was off, so nothing ran.

Scope is guarded by `isMaterializable` (the same predicate as Phase 4): a change edited to a non-materializable target/operation after a dry-run carries a stale status that Phase 5 ignores.

**Gating (mirrors Phase 2/3/4 low-regret):**

- **DEFAULT — warn-only.** A dry-run failure is a strong signal, but synthetic inputs are imperfect; it must not block by default.
- **GATED — `features.strictExecutionDryRun` flips warn→block.** Crucially this flag is **opt-in everywhere — NOT derived from `isProduction`** (unlike `strictCompatibility` / `strictGeneratedContract`). The dry-run depends on external sandbox infrastructure; auto-blocking in prod on an un-configured or flaky sandbox would wedge graduation. Blocking is enabled only when an operator has confirmed the sandbox is healthy.

**Infra vs content failures — distinct handling** (the dry-run stamps the status; Phase 5 reads it):

- no runner configured during materialization → no `dryRunStatus` → phase **skipped** (never blocks).
- runner itself failed (spawn failure, infra down, limits unenforceable) → `dryRunStatus: "infra_error"` → an **INFRA warning**, never a content error, never blocks — don't wedge graduation on a flaky sandbox.
- sandbox killed the child (`timeout`/`oom`) or the handler threw / attempted a forbidden op / returned a bad shape → a **CONTENT finding** on that change, warn-or-block per the flag.

## 8. Failure and Safety Invariants

- **Fail closed on isolation.** If the launcher cannot guarantee §3 (1)–(4) (e.g. OS limits unavailable on the platform), it refuses to run and reports skipped+reason — it never falls back to an unsandboxed `eval`.
- **No graduation coupling.** Phase 5 only ever produces validation findings; it never advances, approves, commits, writes files, or graduates. The double-human gate (draft review + graduation PR) is unchanged.
- **Determinism for repro.** Inputs are recorded by `inputCaseId`; a failing dry-run is reproducible for the reviewer.
- **Tenant + masking discipline.** Historical inputs (if enabled) are tenant-scoped and field-masked before entering the sandbox.

## 9. Rollout Plan (phased — each shippable + smoke-tested)

| Phase | Deliverable | Smoke test (real-boot) |
|---|---|---|
| **P1** | This spec; lean placeholder issues for P2–P5 | — |
| **P2** ✅ | core `dry-run.ts` types + `ExecutionDryRunProvider` seam (for P3) + durable `dryRunStatus`/`dryRunOutcomes` on `ProposalChange` + `ValidationPhase` `1–4`→`1–5` + a **synchronous** `validatePhase5` that READS the durable signal (mirrors Phase 4). No execution; `validateProposal` stays sync. | `validatePhase5` unit: no status → `skipped`; `passed` → no finding; `threw` → warn (block under `strictExecutionDryRun`); `infra_error` → always warn; stale status on a non-materializable change ignored |
| **P3** | capability `createSubprocessDryRunner()` (network-denied `Bun.spawn` + dropped env + temp cwd + timeout-kill + shimmed core), invoked from the **async materialize path** to STAMP `dryRunStatus`/`dryRunOutcomes`. Warn-only end-to-end. | a throwing handler → `threw`; an infinite loop → `timeout`; a clean handler → `passed`; **assert NO real side effect**; the stamped status reaches Phase 5 |
| **P4** | forbidden-op detection (shimmed deps record attempts → `forbidden_side_effect` + `attemptedSideEffects`) + `/admin/proposals` rendering of `dryRunStatus` (extends #514) + scoped single-change re-run (extends #517) | a handler that calls `store.create` → `forbidden_side_effect` with the attempt recorded, real store untouched; UI shows it |
| **P5** | `strictExecutionDryRun` block flag + microVM/container runner tier + OS resource-limit wrapper | block flag flips a `threw` finding to a blocking validation error; microvm runner parity smoke |

Each phase follows the standard lifecycle (worktree → gates → cross-model review → PR) and keeps core execution-free (the runner is always a capability).

## 10. Open Questions (decisions this spec surfaces for the owner)

1. **v1 sandbox tier** — ship the subprocess + OS-level isolation tier first (recommended, zero new deps), or require the container/microVM kernel boundary from P3? Network-egress denial is a **settled v1 requirement either way** (§3, §4.1) — the open choice is only the *mechanism*: an OS network block (Linux namespace / macOS `sandbox-exec` / `--network none`) wrapping the subprocess, versus a microVM from the start, trading setup cost for a stronger kernel boundary.
2. **Runner home** — extend `cap-ai-provider`, or a dedicated new `cap-dry-run` addon? (Core stays execution-free either way.)
3. **Inputs** — synthetic-only for v1, or also replay redacted historical execution-log inputs from P3? (The latter needs tenant-scoped masking work.)
4. **New dependencies** — any non-trivial choice (`isolated-vm`, a container SDK, a cgroups binding) is gated on explicit approval per CLAUDE.md. Flag now if you want a specific technology rather than the recommended dep-free subprocess.

## 11. Relationship to Existing Specs

- **Spec 55 §7.7** — this is the execution counterpart to G5 static materialization; §7.7 should gain a one-line forward-reference once P2 lands.
- **Spec 09** — Phase 5 extends the validation pipeline; the "4-stage validation" description becomes "4 static stages + an optional execution dry-run." Implementation note: the `ValidationPhase` union in `packages/core/src/types/proposal.ts` (currently `1 | 2 | 3 | 4`) gains `5`.
- **Spec 27** — the dry-run is the runtime enforcement point for AI-output safety; prompt-injection payloads that survive generation are caught here behaviorally.
- **Spec 39** — synthetic-input generation and output-contract checking reuse the Execution Contract's notion of an action's input/output shape.
