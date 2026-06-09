/**
 * Execution dry-run types — Spec 70 P2 seam.
 *
 * This is the CORE seam for the generated-code execution dry-run (Spec 70 — the
 * execution companion to Spec 55 §7.7 G5 static materialization). It defines the
 * data shapes a dry-run produces plus the `ExecutionDryRunProvider` interface —
 * the injectable seam a CAPABILITY (e.g. a subprocess sandbox runner) implements
 * in P3. It mirrors the existing `CodeGenerationProvider` pattern: core declares
 * the seam, a capability supplies the impl, tests inject a fake.
 *
 * SAFETY — CORE STAYS EXECUTION-FREE BY DESIGN ("AI never modifies production
 * directly"): core NEVER runs an `ExecutionDryRunProvider` here. P2 only declares
 * the interface (for P3 to implement) and the durable-signal types. The actual
 * sandboxed execution runs LATER (P3) inside a capability, behind opt-in
 * `features.executionDryRun`, and stamps a durable `dryRunStatus` on the change.
 * Validation Phase 5 (`validatePhase5`) only READS that durable status — exactly
 * as Phase 4 reads `materializationStatus` — and never executes anything.
 *
 * `import type` is used throughout so these type-only declarations create no
 * runtime import cycle with `proposal.ts`.
 */

import type { ProposalChangeTarget } from "./proposal";

// ── Dry-run status ───────────────────────────────────────

/**
 * Aggregate outcome of a generated change's execution dry-run. The change-level
 * durable `dryRunStatus` is the WORST-CASE across that change's input cases (any
 * `threw` / `timeout` / `oom` / `forbidden_side_effect` / `malformed_output`
 * dominates `passed`).
 */
export type DryRunStatus =
  /** Ran to completion, well-formed output, no forbidden op. */
  | "passed"
  /** The handler threw. */
  | "threw"
  /** Exceeded the wall-clock limit → killed by the sandbox. */
  | "timeout"
  /** Exceeded the memory cap → killed by the sandbox. */
  | "oom"
  /** Attempted DB / network / fs / env access (recorded, not performed). */
  | "forbidden_side_effect"
  /** Returned a shape violating the action's declared output contract. */
  | "malformed_output"
  /**
   * The sandbox itself failed (spawn error, missing binary, limits
   * unenforceable). This is NOT a content verdict — Phase 5 surfaces it as a
   * WARNING that never blocks, even under strict gating (Spec 70 §7).
   */
  | "infra_error"
  /** Not materializable / no valid source / no runner configured. */
  | "skipped";

// ── Recorded side-effect attempt ─────────────────────────

/**
 * A side-effecting operation the handler ATTEMPTED inside the sandbox. The
 * shimmed dependencies RECORD the attempt rather than performing it, so a
 * forbidden op is detected, never executed for real.
 */
export interface AttemptedSideEffect {
  /** Which I/O surface the handler reached for. */
  kind: "db_write" | "db_read" | "network" | "fs" | "env" | "unknown";
  /** e.g. "store.create('order', …)" — truncated, no payload. */
  detail: string;
}

// ── Per-input-case dry-run outcome ───────────────────────

/**
 * The outcome of running ONE generated change against ONE input case in the
 * sandbox. The P3 materialize-path runner fans the provider out over every
 * (change × synthetic/historical input) pair, collects the per-case array, and
 * stamps the worst-case aggregate as the durable change-level `dryRunStatus`
 * that validation Phase 5 then reads.
 */
export interface DryRunOutcome {
  /** The change whose generated source was run. */
  changeName: string;
  /** The change's target (today only `action` is materializable). */
  target: ProposalChangeTarget;
  /** This case's outcome. */
  status: DryRunStatus;
  /** Wall-clock duration of this case, when measured. */
  durationMs?: number;
  /** Peak memory observed for this case, when measured. */
  peakMemoryBytes?: number;
  /** Side-effecting ops the handler attempted (recorded, never performed). */
  attemptedSideEffects?: AttemptedSideEffect[];
  /** Truncated message if it threw. */
  error?: string;
  /**
   * Captured + truncated child stdout/stderr (stack traces, console.*) so the
   * reviewer can debug a failing dry-run in the UI.
   */
  logs?: string;
  /** Which synthetic/historical input produced this outcome (repro). */
  inputCaseId?: string;
}

// ── Provider seam (P3 implements; core never calls it here) ──

/**
 * Injectable seam for the execution dry-run (Spec 70). A CAPABILITY implements
 * this in P3 (e.g. a hardened `Bun.spawn` subprocess runner); core declares the
 * interface only and NEVER invokes it during validation. Mirrors the
 * `CodeGenerationProvider` injectable-seam pattern.
 */
export interface ExecutionDryRunProvider {
  /**
   * Run ONE generated change against ONE input case in the sandbox, returning
   * that case's outcome (carrying its `inputCaseId` for reproducibility). The P3
   * materialize-path runner fans this out over every (change × synthetic/
   * historical input) pair — each in its own isolated sandbox — collects the
   * per-case `DryRunOutcome[]`, and stamps the WORST-CASE aggregate as the
   * durable `dryRunStatus` (validation Phase 5 only READS that; it never calls
   * this provider).
   */
  dryRun(job: {
    /** The AI-materialized TypeScript source to run. */
    source: string;
    /** The change's target (today only `action`). */
    target: ProposalChangeTarget;
    /** The declared change name. */
    changeName: string;
    /** The synthetic/historical input fed to the handler. */
    input: unknown;
    /** Identifies the input case for reproducibility. */
    inputCaseId: string;
    /** Injected into the shimmed, tenant-scoped sandbox context. */
    tenantId?: string;
    /** ExecutionMeta-like fields the handler may read (Spec 65). */
    metadata?: Record<string, unknown>;
    /** Hard resource bounds the sandbox enforces (kill on breach). */
    limits: { timeoutMs: number; memoryBytes: number };
  }): Promise<DryRunOutcome>;
}
