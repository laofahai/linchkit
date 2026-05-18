/**
 * Intent scenario adapter — fixture → production `resolveIntent` → IntentEvalOutput.
 *
 * # Why this lives here (and not in `@linchkit/devtools`)
 *
 * The eval framework's whole purpose is to gate regressions in the
 * production prompt + parser + reconciliation pipeline. If the adapter
 * shipped its own simplified copy of that pipeline (as the original
 * Phase 1 PoC did), prompt or parser drift in `intent-prompt.ts` and
 * `intent-resolver.ts` would silently slip past every fixture. Calling
 * the real `resolveIntent` is the load-bearing invariant.
 *
 * The structural split:
 *   • The generic framework (types, matchers, runner, baseline, CLI, registry)
 *     stays scenario-agnostic in `@linchkit/devtools`.
 *   • This adapter — and any future capability-specific adapter — lives
 *     inside the capability that owns the production code being evaluated.
 *
 * # Hash-drift detection
 *
 * `replayFromBaseline` delegates to `findBaselineEntry` from devtools,
 * which throws when the fixture's current hash differs from the
 * recorded `fixtureHash`. This satisfies spec 69 §6.4's fail-loud rule
 * for fixtures whose input/context changed since the baseline was
 * written (the previous PoC only checked for absent entries).
 */

import type { ActionDefinition, AIService, FieldDefinition } from "@linchkit/core";
import {
  type OntologyRegistryLike as DevtoolsOntologyRegistryLike,
  findBaselineEntry,
  type InlineCatalogAction,
  type IntentEvalOutput,
  type IntentFixtureContext,
  type IntentFixtureInput,
  type ScenarioAdapter,
} from "@linchkit/devtools";
import {
  type ActionProposal,
  type OntologyRegistryLike as ResolverOntologyRegistryLike,
  resolveIntent,
} from "../intent-resolver";

// ── Public deps shape ────────────────────────────────────────

/**
 * Runtime dependencies the live adapter needs. `ontology` satisfies the
 * stricter production ontology shape; `loadInlineCatalog` returns the
 * devtools-flavoured `InlineCatalogAction` (the structurally weaker
 * fixture-authoring shape) and the adapter wraps those entries into a
 * per-fixture ontology before calling `resolveIntent`.
 */
export interface IntentScenarioDeps {
  ai: AIService;
  /** Used when a fixture's `catalogSource` starts with `demo:`. */
  ontology: ResolverOntologyRegistryLike;
  /** Resolves `inline:<name>` catalog sources. Required when any fixture uses one. */
  loadInlineCatalog?: (name: string) => Promise<ReadonlyArray<InlineCatalogAction>>;
  /** Model alias forwarded to `ai.complete()` via resolveIntent. */
  model?: string;
  /** Tenant id forwarded to `resolveIntent` for BYOK config resolution. */
  tenantId?: string;
}

export type IntentScenarioAdapter = ScenarioAdapter<
  IntentFixtureInput,
  IntentFixtureContext,
  IntentEvalOutput,
  IntentScenarioDeps
>;

// ── Factory ─────────────────────────────────────────────────

export function createIntentScenario(): IntentScenarioAdapter {
  return {
    async runLive(fx, deps) {
      const ontology = await resolveOntology(fx.context, deps);
      const startedAt = performance.now();
      const proposal = await resolveIntent(
        {
          prompt: fx.input.userMessage,
          scope: fx.context?.scope,
          tenant: deps.tenantId,
        },
        { ai: deps.ai, ontology },
      );
      const latencyMs = Math.round(performance.now() - startedAt);
      return proposalToIntentEvalOutput(proposal, latencyMs);
    },

    replayFromBaseline(fx, baseline) {
      const entry = findBaselineEntry<IntentEvalOutput>(fx, baseline);
      return entry.aiOutput;
    },
  };
}

// ── Per-fixture ontology resolution ─────────────────────────

/**
 * Pick the action surface a fixture evaluates against. The two supported
 * prefixes mirror the original PoC (Spec 69 §4.1 catalogSource convention):
 *   • `inline:<name>` — load the named JSON catalog via `deps.loadInlineCatalog`
 *     and wrap its actions as an ad-hoc `OntologyRegistryLike` whose
 *     `actionsFor(entity)` returns the actions that match that entity.
 *     Used by adversarial / mixed-capability fixtures whose action shape
 *     must be controlled per-test.
 *   • `demo:<capName>` — use `deps.ontology` straight, so the resolver
 *     sees whatever the live OntologyRegistry exposes for that capability.
 */
async function resolveOntology(
  context: IntentFixtureContext | undefined,
  deps: IntentScenarioDeps,
): Promise<ResolverOntologyRegistryLike> {
  const source = context?.catalogSource;
  if (!source) {
    throw new Error("intent scenario: fixture.context.catalogSource is required");
  }

  if (source.startsWith("inline:")) {
    if (!deps.loadInlineCatalog) {
      throw new Error(
        `intent scenario: catalogSource "${source}" requires deps.loadInlineCatalog, none provided`,
      );
    }
    const name = source.slice("inline:".length);
    const actions = await deps.loadInlineCatalog(name);
    return buildInlineOntology(actions);
  }

  if (source.startsWith("demo:")) {
    return deps.ontology;
  }

  throw new Error(
    `intent scenario: unsupported catalogSource "${source}" (expected demo:<name> or inline:<name>)`,
  );
}

function buildInlineOntology(
  actions: ReadonlyArray<InlineCatalogAction>,
): ResolverOntologyRegistryLike {
  const byEntity = new Map<string, ActionDefinition[]>();
  for (const action of actions) {
    const list = byEntity.get(action.entity) ?? [];
    list.push(toActionDefinition(action));
    byEntity.set(action.entity, list);
  }
  return {
    listEntities: () => Array.from(byEntity.keys()),
    actionsFor: (entityName) => byEntity.get(entityName) ?? [],
  };
}

/**
 * Coerce a devtools-shape `InlineCatalogAction` into a production
 * `ActionDefinition`. The intent-resolver only reads name/entity/label/
 * description/input/ai.promptHints, so the synthesised `policy` is a
 * stub — it is never evaluated by the resolver, only required by the
 * TypeScript shape. The `input` cast through `unknown` is the boundary
 * cost of letting fixture JSON ship with a loose `field.type: string`
 * instead of the discriminated `FieldDefinition` union.
 */
function toActionDefinition(action: InlineCatalogAction): ActionDefinition {
  return {
    name: action.name,
    entity: action.entity,
    label: action.label,
    description: action.description,
    input: action.input as unknown as Record<string, FieldDefinition> | undefined,
    policy: { mode: "sync", transaction: false },
  };
}

// Re-export devtools' weaker public ontology shape so addon consumers
// only need one import path for fixture/test authoring helpers.
export type { DevtoolsOntologyRegistryLike };

// ── ActionProposal → IntentEvalOutput ───────────────────────

function proposalToIntentEvalOutput(
  proposal: ActionProposal | null,
  latencyMs: number,
): IntentEvalOutput {
  // A null proposal is a deliberate refusal from the resolver (empty prompt,
  // empty catalog, sub-threshold confidence, malformed AI response, …). The
  // matchers downstream rely on `action: null` to detect refusals — they
  // never receive an undefined here.
  if (proposal === null) {
    return {
      action: null,
      input: {},
      confidence: 0,
      missingFields: [],
      explanation: "",
      latencyMs,
    };
  }
  const out: IntentEvalOutput = {
    action: proposal.action,
    input: proposal.input,
    confidence: proposal.confidence,
    missingFields: proposal.missingFields,
    explanation: proposal.explanation,
    latencyMs,
  };
  if (proposal.alternatives && proposal.alternatives.length > 0) {
    out.alternatives = proposal.alternatives.map((alt) =>
      proposalToIntentEvalOutput(alt, latencyMs),
    );
  }
  return out;
}
