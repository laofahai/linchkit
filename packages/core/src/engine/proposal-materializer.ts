/**
 * Proposal materializer (G5 Phase 3).
 *
 * Generates the irreducibly-code parts of a proposal — today the
 * `ActionDefinition.handler` body, which a declarative `ChangeDefinition` cannot
 * express — into TypeScript source, attaching it to each change as
 * `generatedSource`. Declarative targets (entity / rule / view / state / event /
 * overlay) are left to deterministic serialization and are skipped here. The
 * materializable set is extensible (see {@link MATERIALIZABLE_TARGETS}).
 *
 * Pipeline per materializable change: build a prompt → `CodeGenerationProvider`
 * generates source → (optional) `QualityGateRunner` build-checks it → on failure
 * retry with the errors fed back, up to `maxRetries`. Generation is LAZY and
 * caller-driven (no scheduler).
 *
 * SAFETY BOUNDARY ("AI never modifies production directly"): this returns a COPY
 * of the proposal with candidate source attached. It NEVER writes files, runs
 * the generated code, approves, or graduates anything. The attached source still
 * flows through validation (Phase 2 build check) and double human review (draft
 * review + graduation PR) before it can land.
 */

import type { CodeGenerationProvider, QualityGateRunner } from "../ai/proposal-code-generator";
import type { ProposalChange, ProposalChangeTarget, ProposalDefinition } from "../types/proposal";

/**
 * Change targets whose logic must be AI-materialized (cannot be serialized
 * declaratively). Today only `action` qualifies: `ActionDefinition.handler` is a
 * real function body. Other current targets are declarative — `entity` / `rule`
 * / `view` / `state` / `event` (an EventDefinition is name + payload, not logic)
 * / `overlay` — and `flow` has no `defineFlow` API yet. Adding a target here (and
 * to {@link TARGET_GUIDANCE}) is all it takes to extend scope when those land.
 */
const MATERIALIZABLE_TARGETS: ReadonlySet<ProposalChangeTarget> = new Set(["action"]);

/** True when a change needs AI code generation (a code target, created or updated). */
export function isMaterializable(change: ProposalChange): boolean {
  return (
    MATERIALIZABLE_TARGETS.has(change.target) &&
    (change.operation === "create" || change.operation === "update")
  );
}

export interface MaterializeProposalOptions {
  /** Proposal to materialize. Not mutated — a copy is returned. */
  proposal: ProposalDefinition;
  /** AI code generation provider (e.g. cap-ai-provider's createCodeGenerationProvider). */
  provider: CodeGenerationProvider;
  /**
   * Optional build/quality gate (Phase 2). When provided, generated source must
   * pass it; a failure feeds the errors back into the next attempt. When absent,
   * the first generation is accepted (validation still runs downstream).
   */
  qualityGate?: QualityGateRunner;
  /** Max generation attempts per change (default 3, floored at 1). */
  maxRetries?: number;
  /**
   * Project conventions / existing-entity context, passed as the system message
   * to the provider on every attempt.
   */
  context?: string;
  /**
   * When provided (non-empty), ONLY changes whose `name` is in this set are
   * (re)materialized; every other change is preserved UNTOUCHED (its existing
   * `generatedSource` / `materializationStatus` / `materializationErrors` are
   * kept) and reported with outcome status `skipped`. When absent/empty, ALL
   * materializable changes are materialized (current behavior).
   *
   * Use case: retrying a single FAILED change without re-calling the AI provider
   * for changes that already succeeded — the model is non-deterministic, so
   * regenerating a good candidate can REGRESS it.
   */
  changeNames?: readonly string[];
}

export interface MaterializeChangeOutcome {
  changeName: string;
  target: ProposalChangeTarget;
  /** `materialized` = source attached; `skipped` = declarative target; `failed` = gate never passed. */
  status: "materialized" | "skipped" | "failed";
  /** Number of generation attempts made (0 for skipped). */
  attempts: number;
  /** Quality-gate errors from the final failed attempt (only when status="failed"). */
  errors?: string[];
}

export interface MaterializeProposalResult {
  /** A COPY of the input proposal with `generatedSource` attached to materialized changes. */
  proposal: ProposalDefinition;
  /** Per-change outcome, in input order. */
  outcomes: MaterializeChangeOutcome[];
  /** True when no materializable change failed (skipped/declarative changes don't count against this). */
  allMaterialized: boolean;
}

/**
 * Generate source for each materializable change in a proposal, returning a copy
 * with `generatedSource` attached. Never mutates the input.
 */
export async function materializeProposalChanges(
  options: MaterializeProposalOptions,
): Promise<MaterializeProposalResult> {
  const { proposal, provider, qualityGate, context } = options;
  // Guard a non-finite maxRetries (NaN/Infinity) — Math.floor(NaN) would make the
  // retry loop skip every attempt and report a spurious failure.
  const requestedRetries = options.maxRetries;
  const maxRetries = Math.max(
    1,
    Math.floor(
      typeof requestedRetries === "number" && Number.isFinite(requestedRetries)
        ? requestedRetries
        : 3,
    ),
  );

  // Per-change shallow copies — we only ever set `generatedSource`.
  const changes: ProposalChange[] = proposal.changes.map((c) => ({ ...c }));
  const outcomes: MaterializeChangeOutcome[] = [];

  // Optional scope: when a non-empty `changeNames` is given, only those changes
  // are (re)materialized. Out-of-scope changes are preserved untouched (their
  // existing source/status/errors are NOT cleared) so retrying one FAILED change
  // never regenerates — and risks regressing — the already-good ones.
  const scope =
    options.changeNames && options.changeNames.length > 0 ? new Set(options.changeNames) : null;

  for (const change of changes) {
    // Out-of-scope (only when a scope was given): the point of scoping is to NOT
    // regenerate already-good changes. But a non-materializable change must never
    // be left with stale materialization artifacts.
    if (scope && !scope.has(change.name)) {
      // A NON-materializable out-of-scope change (e.g. one edited action→entity
      // since it was last materialized) must NOT retain a stale `generatedSource`
      // — `ProposalFileWriter` would write it at graduation. Clear it exactly as
      // the in-scope declarative path does, and report "skipped".
      if (!isMaterializable(change)) {
        change.generatedSource = undefined;
        change.materializationStatus = undefined;
        change.materializationErrors = undefined;
        outcomes.push({
          changeName: change.name,
          target: change.target,
          status: "skipped",
          attempts: 0,
        });
        continue;
      }
      // Materializable + out-of-scope: PRESERVE it untouched (don't regenerate a
      // good candidate), and report its CARRIED-FORWARD durable status — NOT a
      // blanket "skipped". A change still `failed` from an earlier pass must
      // surface as "failed" so it is not hidden from the outcomes/`allMaterialized`
      // summary (else a scoped retry of A could misreport the proposal as fully
      // materialized while B is still broken).
      const carried: MaterializeChangeOutcome["status"] =
        change.materializationStatus === "failed"
          ? "failed"
          : change.materializationStatus === "materialized"
            ? "materialized"
            : "skipped";
      outcomes.push({
        changeName: change.name,
        target: change.target,
        status: carried,
        attempts: 0,
        ...(carried === "failed" && change.materializationErrors
          ? { errors: change.materializationErrors }
          : {}),
      });
      continue;
    }

    // Clear any pre-existing source AND durable quality signal up front — BEFORE
    // the materializable check — so neither a re-materialization NOR a change
    // that became non-materializable (its target/operation was edited, e.g.
    // action→entity or create→delete) ever leaves a STALE source/status/errors
    // behind. They are set again only as a materializable attempt resolves; a
    // skipped (declarative) change correctly carries no materialization artifacts.
    change.generatedSource = undefined;
    change.materializationStatus = undefined;
    change.materializationErrors = undefined;

    if (!isMaterializable(change)) {
      outcomes.push({
        changeName: change.name,
        target: change.target,
        status: "skipped",
        attempts: 0,
      });
      continue;
    }

    let lastErrors: string[] = [];
    let materialized = false;
    let attempt = 0;
    for (attempt = 1; attempt <= maxRetries; attempt++) {
      const prompt = buildChangePrompt(change, proposal, lastErrors);
      const raw = await provider.generateCode(prompt, context);
      const source = stripCodeFence(raw);

      if (qualityGate) {
        const errors = await qualityGate.check({ [`${change.name}.ts`]: source });
        if (errors.length > 0) {
          lastErrors = errors;
          continue;
        }
      }

      change.generatedSource = source;
      // Durable success signal: source is attached, errors stay cleared.
      change.materializationStatus = "materialized";
      materialized = true;
      break;
    }

    // Durable failure signal: no candidate source survived the gate. Stamp the
    // status + the final attempt's errors onto the change so a reviewer reading
    // the PERSISTED proposal sees WHY, independent of the transient outcomes.
    if (!materialized) {
      change.materializationStatus = "failed";
      change.materializationErrors = lastErrors;
    }

    outcomes.push(
      materialized
        ? {
            changeName: change.name,
            target: change.target,
            status: "materialized",
            attempts: attempt,
          }
        : {
            changeName: change.name,
            target: change.target,
            status: "failed",
            attempts: maxRetries,
            errors: lastErrors,
          },
    );
  }

  // `allMaterialized` = every MATERIALIZABLE change has successfully-materialized
  // source. Derived from the durable change state (NOT the per-round outcomes) so
  // a SCOPED run reports the WHOLE proposal honestly: an out-of-scope
  // materializable change that is still `failed` OR was NEVER materialized (no
  // source) keeps this false — only a non-materializable (declarative) change or
  // a truly materialized one passes. Equivalent to the old outcomes check in the
  // unscoped case (where every materializable change is attempted every run).
  const allMaterialized = changes.every(
    (c) => !isMaterializable(c) || c.materializationStatus === "materialized",
  );
  return { proposal: { ...proposal, changes }, outcomes, allMaterialized };
}

// ── Prompt building ──────────────────────────────────────

const TARGET_GUIDANCE: Record<string, string> = {
  action:
    'Use defineAction() from "@linchkit/core". Implement the `handler: (ctx) => Promise<...>` body fully.',
};

/** Build the per-change generation prompt (with retry feedback when present). */
function buildChangePrompt(
  change: ProposalChange,
  proposal: ProposalDefinition,
  previousErrors: string[],
): string {
  const lines: string[] = [];

  if (previousErrors.length > 0) {
    lines.push("# RETRY — the previous attempt failed the build/syntax check:");
    for (const e of previousErrors) lines.push(`- ${e}`);
    lines.push("Fix these and output a corrected, complete file.");
    lines.push("");
  }

  lines.push("# Generate a complete LinchKit definition file");
  lines.push("");
  lines.push(`Target: ${change.target}`);
  lines.push(`Operation: ${change.operation}`);
  lines.push(`Name: ${change.name}`);
  lines.push(`Capability: ${proposal.capability}`);
  lines.push(`Proposal: ${proposal.title}`);
  if (proposal.description) lines.push(`Description: ${proposal.description}`);
  if (change.diff) lines.push(`Change summary: ${change.diff}`);

  if (change.definition) {
    lines.push("");
    lines.push("Declarative definition (JSON) to implement:");
    lines.push("```json");
    lines.push(JSON.stringify(change.definition, null, 2));
    lines.push("```");
  }

  lines.push("");
  lines.push("Requirements:");
  lines.push("- Output ONLY the TypeScript source for a single file — no markdown, no commentary.");
  lines.push('- Include all necessary imports from "@linchkit/core".');
  lines.push(`- ${TARGET_GUIDANCE[change.target] ?? "Implement the logic body fully."}`);
  lines.push("- TypeScript strict mode; never use the `any` type.");
  lines.push("- Action naming: verb_noun. Entity naming: snake_case.");

  return lines.join("\n");
}

/**
 * Extract TypeScript source from a model response. Despite the "output only
 * source" instruction, models sometimes wrap the code in a markdown fence or
 * surround that fence with conversational prose ("Sure! Here is the code: ...").
 * Handles all three shapes — bare source, a fenced block, or a fenced block
 * embedded in prose — and returns "" for a non-string input rather than throwing.
 */
function stripCodeFence(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  // A fenced block anywhere (even wrapped in prose) — take the first block's body.
  const fenced = trimmed.match(/```[a-zA-Z]*\r?\n([\s\S]*?)```/);
  if (fenced) return (fenced[1] ?? "").trim();
  // An opening fence with no closing fence — drop the opener (and a dangling one).
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```[a-zA-Z]*\r?\n?/, "")
      .replace(/\r?\n?```$/, "")
      .trim();
  }
  return trimmed;
}
