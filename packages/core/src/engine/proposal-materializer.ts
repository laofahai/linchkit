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
  const maxRetries = Math.max(1, Math.floor(options.maxRetries ?? 3));

  // Per-change shallow copies — we only ever set `generatedSource`.
  const changes: ProposalChange[] = proposal.changes.map((c) => ({ ...c }));
  const outcomes: MaterializeChangeOutcome[] = [];

  for (const change of changes) {
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
      materialized = true;
      break;
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

  const allMaterialized = outcomes.every((o) => o.status !== "failed");
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

/** Strip a single leading/trailing markdown code fence the model may add despite instructions. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  // Drop the opening fence line (``` or ```ts / ```typescript) and a trailing fence.
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\n?/, "");
  return withoutOpen.replace(/\n?```$/, "").trim();
}
