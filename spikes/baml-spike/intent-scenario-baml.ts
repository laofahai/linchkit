/**
 * Intent scenario adapter — fixture → BAML `b.ResolveIntent` → IntentEvalOutput.
 *
 * Spec 69 Phase 2b spike sibling of `intent-scenario.ts`. The production
 * adapter calls `resolveIntent()` (the Zod + extractFirstJsonObject pipeline);
 * this adapter routes the same fixture through BAML's Schema-Aligned Parser
 * (SAP) instead so the two baselines can be diffed apples-to-apples.
 *
 * What is shared with production:
 *   • Per-fixture ontology resolution (inline:* and demo:* catalog sources)
 *     and the structural ActionDefinition coercion. Copied here verbatim
 *     because the production adapter doesn't export them — keeping the spike
 *     self-contained avoids reaching into intent-scenario.ts internals.
 *   • The sanitizeText() control-char strip applied to user-controlled
 *     metadata before JSON-stringifying the catalog. Mirrors the rule in
 *     `src/intent-prompt.ts` so BAML sees the same prompt-injection defense.
 *   • The catalog allowlist / scope filter / reconciliation rules
 *     (drop unknown fields, surface required-but-missing, refuse out-of-
 *     catalog actions, MIN_CONFIDENCE floor, alternatives cap + threshold).
 *
 * What is NEW here:
 *   • Schema injection is delegated to BAML's `ctx.output_format` (see
 *     `baml_src/intent.baml`). Rule 8 from the production prompt is no longer
 *     hand-written.
 *   • Parsing is delegated to BAML's SAP. No JSON.parse, no Zod, no
 *     extractFirstJsonObject heuristics.
 *
 * Nothing else moves — the matchers and fixture loader are unchanged so a
 * baseline diff isolates the parser+schema change.
 */

import type { ActionDefinition, AIService, FieldDefinition } from "@linchkit/core";
import {
  findBaselineEntry,
  type InlineCatalogAction,
  type IntentEvalOutput,
  type IntentFixtureContext,
  type IntentFixtureInput,
  type ScenarioAdapter,
} from "@linchkit/devtools";
import { b as bamlClient } from "../baml_client";
import type { IntentResolution } from "../baml_client/types";
import type {
  BuildIntentSystemPromptOptions,
  ActionCatalogEntry as PromptCatalogEntry,
} from "../src/intent-prompt";
import type { OntologyRegistryLike as ResolverOntologyRegistryLike } from "../src/intent-resolver";
import {
  ALTERNATIVES_CONFIDENCE_THRESHOLD,
  MAX_ALTERNATIVES,
  MIN_CONFIDENCE,
} from "../src/intent-resolver";

// ── Public deps shape ────────────────────────────────────────

/**
 * Runtime dependencies the BAML adapter needs. Note that `ai` is REQUIRED
 * by the shared interface but unused here — BAML owns its own client
 * connection via the `ZhipuGlm4Flash` block in `baml_src/intent.baml`.
 * We keep the field so the CLI can keep injecting the same deps object
 * into both scenarios without branching.
 */
export interface IntentBamlScenarioDeps {
  /** Unused — BAML owns its provider config. Kept for CLI symmetry. */
  ai: AIService;
  /** Used when a fixture's `catalogSource` starts with `demo:`. */
  ontology: ResolverOntologyRegistryLike;
  /** Resolves `inline:<name>` catalog sources. Required when any fixture uses one. */
  loadInlineCatalog?: (name: string) => Promise<ReadonlyArray<InlineCatalogAction>>;
  /**
   * Model alias forwarded to BAML's client override. Not currently used —
   * the BAML client is pinned at the .baml file. Kept so CliDeps stays
   * structurally compatible.
   */
  model?: string;
  /** Tenant id — unused by BAML (no per-tenant BYOK in the spike). */
  tenantId?: string;
}

export type IntentBamlScenarioAdapter = ScenarioAdapter<
  IntentFixtureInput,
  IntentFixtureContext,
  IntentEvalOutput,
  IntentBamlScenarioDeps
>;

// ── Factory ─────────────────────────────────────────────────

export function createIntentBamlScenario(): IntentBamlScenarioAdapter {
  return {
    async runLive(fx, deps) {
      const trimmedPrompt = fx.input.userMessage.trim();
      if (trimmedPrompt.length === 0) {
        return refusalOutput(0);
      }

      const ontology = await resolveOntology(fx.context, deps);
      const catalog = buildActionCatalog(ontology, fx.context?.scope);
      if (catalog.length === 0) {
        return refusalOutput(0);
      }

      const catalogIndex = new Map(catalog.map((entry) => [entry.name, entry]));
      const catalogJson = serializeCatalogForPrompt(catalog);

      const startedAt = performance.now();
      let raw: IntentResolution;
      try {
        raw = await bamlClient.ResolveIntent(
          catalogJson,
          trimmedPrompt,
          ALTERNATIVES_CONFIDENCE_THRESHOLD,
          MAX_ALTERNATIVES,
        );
      } catch {
        // Whole-call failure (BamlValidationError, HTTP, etc.) — treat
        // as a refusal so the matchers can record a null proposal,
        // mirroring production's graceful-degradation behaviour.
        return refusalOutput(Math.round(performance.now() - startedAt));
      }
      const latencyMs = Math.round(performance.now() - startedAt);

      return reconcileBamlOutput(raw, catalogIndex, latencyMs);
    },

    replayFromBaseline(fx, baseline) {
      const entry = findBaselineEntry<IntentEvalOutput>(fx, baseline);
      return entry.aiOutput;
    },
  };
}

// ── Catalog construction (shared rules, local copy) ─────────

/**
 * Mirrors `buildActionCatalog` in src/intent-resolver.ts: applies
 * entityFilter / actionFilter scope, deduplicates by action name, and
 * coerces ActionDefinition → ActionCatalogEntry so the prompt JSON shape
 * matches production exactly. Kept local because the resolver does not
 * export it.
 */
function buildActionCatalog(
  ontology: ResolverOntologyRegistryLike,
  scope: IntentFixtureContext["scope"],
): PromptCatalogEntry[] {
  const entityFilter = toFilterSet(scope?.entityFilter);
  const actionFilter = toFilterSet(scope?.actionFilter);

  const seen = new Set<string>();
  const catalog: PromptCatalogEntry[] = [];

  for (const entityName of ontology.listEntities()) {
    if (entityFilter && !entityFilter.has(entityName)) continue;

    for (const action of ontology.actionsFor(entityName)) {
      if (seen.has(action.name)) continue;
      if (actionFilter && !actionFilter.has(action.name)) continue;
      seen.add(action.name);
      catalog.push(toCatalogEntry(action));
    }
  }

  return catalog;
}

function toCatalogEntry(action: ActionDefinition): PromptCatalogEntry {
  const inputFields: PromptCatalogEntry["inputFields"] = [];
  if (action.input) {
    for (const [name, field] of Object.entries(action.input)) {
      inputFields.push({
        name,
        type: field.type,
        required: field.required === true,
        label: field.label,
        description: field.description,
        allowEmpty: field.allowEmpty === true ? true : undefined,
      });
    }
  }

  const hints = action.ai?.promptHints;
  const description =
    [action.description, ...(hints ?? [])].filter((s): s is string => Boolean(s)).join(" — ") ||
    undefined;

  return {
    name: action.name,
    entity: action.entity,
    label: action.label,
    description,
    inputFields,
  };
}

function toFilterSet(values: readonly string[] | undefined): Set<string> | undefined {
  if (!values || values.length === 0) return undefined;
  return new Set(values);
}

/**
 * Serialize the catalog into the prompt-safe JSON shape produced by
 * `buildIntentSystemPrompt` in src/intent-prompt.ts, minus the prose
 * scaffolding. We feed BAML the SAME JSON the production prompt feeds the
 * model so the comparison is apples-to-apples — the only thing that
 * changes is who writes the prompt scaffolding and who parses the answer.
 */
function serializeCatalogForPrompt(catalog: PromptCatalogEntry[]): string {
  if (catalog.length === 0) {
    return "[] // no actions available in current scope";
  }
  const safe = catalog.map((a) => ({
    name: a.name,
    entity: a.entity,
    label: sanitizeText(a.label),
    description: a.description ? sanitizeText(a.description) : undefined,
    inputFields: a.inputFields.map((f) => ({
      name: f.name,
      type: f.type,
      required: f.required,
      ...(f.allowEmpty === true ? { allowEmpty: true } : {}),
      label: f.label ? sanitizeText(f.label) : undefined,
      description: f.description ? sanitizeText(f.description) : undefined,
    })),
  }));
  return JSON.stringify(safe, null, 2);
}

/**
 * Strip ASCII control characters (except tab). Local copy of the rule in
 * src/intent-prompt.ts — that file does not export sanitizeText, and we
 * intentionally keep the BAML adapter free of imports from
 * intent-prompt.ts to avoid drift if the prompt builder is later inlined
 * with sanitization elsewhere.
 */
function sanitizeText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character removal
  return value.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

// ── Per-fixture ontology resolution (mirrors production adapter) ─

async function resolveOntology(
  context: IntentFixtureContext | undefined,
  deps: IntentBamlScenarioDeps,
): Promise<ResolverOntologyRegistryLike> {
  const source = context?.catalogSource;
  if (!source) {
    throw new Error("intent-baml scenario: fixture.context.catalogSource is required");
  }

  if (source.startsWith("inline:")) {
    if (!deps.loadInlineCatalog) {
      throw new Error(
        `intent-baml scenario: catalogSource "${source}" requires deps.loadInlineCatalog, none provided`,
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
    `intent-baml scenario: unsupported catalogSource "${source}" (expected demo:<name> or inline:<name>)`,
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

// ── BAML output → IntentEvalOutput (matches production reconciliation) ─

/**
 * Apply the same post-parse reconciliation rules that intent-resolver.ts
 * runs after Zod validation: catalog allowlist, MIN_CONFIDENCE floor,
 * input field whitelist + missingFields surfacing, alternatives cap +
 * threshold + dedup vs primary. The whole point of the spike is to
 * compare PARSER quality, not reconciliation behavior — every other rule
 * stays identical so the diff is interpretable.
 */
function reconcileBamlOutput(
  raw: IntentResolution,
  catalogIndex: Map<string, PromptCatalogEntry>,
  latencyMs: number,
): IntentEvalOutput {
  if (raw.action == null) {
    return refusalOutput(latencyMs);
  }

  const catalogEntry = catalogIndex.get(raw.action);
  if (!catalogEntry) {
    return refusalOutput(latencyMs);
  }

  const confidence = clampConfidence(raw.confidence);
  if (confidence < MIN_CONFIDENCE) {
    return refusalOutput(latencyMs);
  }

  const { input, missingFields } = reconcileInput(catalogEntry, raw.input ?? {});

  const out: IntentEvalOutput = {
    action: catalogEntry.name,
    input,
    confidence,
    missingFields,
    explanation: raw.explanation || `Proposed action: ${catalogEntry.name}`,
    latencyMs,
  };

  const reconciled =
    confidence < ALTERNATIVES_CONFIDENCE_THRESHOLD
      ? reconcileAlternatives(raw.alternatives, catalogIndex, catalogEntry.name, latencyMs)
      : undefined;
  if (reconciled && reconciled.length > 0) {
    out.alternatives = reconciled;
  }

  return out;
}

interface ReconciledInput {
  input: Record<string, unknown>;
  missingFields: string[];
}

function reconcileInput(
  entry: PromptCatalogEntry,
  proposed: Record<string, unknown>,
): ReconciledInput {
  const known = new Map(entry.inputFields.map((f) => [f.name, f]));
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(proposed)) {
    if (!known.has(key)) continue;
    if (value === undefined) continue;
    cleaned[key] = value;
  }

  const missingFields: string[] = [];
  for (const field of entry.inputFields) {
    if (!field.required) continue;
    const value = cleaned[field.name];
    if (value === undefined || value === null) {
      missingFields.push(field.name);
      continue;
    }
    if (value === "" && field.allowEmpty !== true) {
      missingFields.push(field.name);
    }
  }

  return { input: cleaned, missingFields };
}

function reconcileAlternatives(
  rawAlternatives: IntentResolution["alternatives"],
  catalogIndex: Map<string, PromptCatalogEntry>,
  primaryActionName: string,
  latencyMs: number,
): IntentEvalOutput[] | undefined {
  if (!rawAlternatives || rawAlternatives.length === 0) return undefined;

  const seen = new Set<string>([primaryActionName]);
  const reconciled: IntentEvalOutput[] = [];

  for (const alt of rawAlternatives) {
    if (!alt || typeof alt.action !== "string") continue;
    if (seen.has(alt.action)) continue;
    const catalogEntry = catalogIndex.get(alt.action);
    if (!catalogEntry) continue;

    const altConfidence = clampConfidence(alt.confidence);
    if (altConfidence < MIN_CONFIDENCE) continue;

    const { input, missingFields } = reconcileInput(catalogEntry, alt.input ?? {});

    seen.add(catalogEntry.name);
    reconciled.push({
      action: catalogEntry.name,
      input,
      confidence: altConfidence,
      missingFields,
      explanation: alt.explanation || `Proposed action: ${catalogEntry.name}`,
      latencyMs,
    });
  }

  if (reconciled.length === 0) return undefined;

  reconciled.sort((a, b) => b.confidence - a.confidence);
  return reconciled.slice(0, MAX_ALTERNATIVES);
}

function refusalOutput(latencyMs: number): IntentEvalOutput {
  return {
    action: null,
    input: {},
    confidence: 0,
    missingFields: [],
    explanation: "",
    latencyMs,
  };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// Re-export the prompt-options interface so the BAML adapter's deps shape
// stays self-documenting even though the spike doesn't currently expose
// per-call threshold tuning. Kept for parity with future adapters that
// might thread `BuildIntentSystemPromptOptions` through.
export type { BuildIntentSystemPromptOptions };
