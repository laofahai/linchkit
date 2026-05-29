/**
 * Natural-Language → Action Proposal Resolver
 *
 * Spec 52 Phase 0 PoC. Future home may be a dedicated `cap-nl-intent`
 * capability if the surface area grows; for now the resolver lives next to
 * cap-ai-provider since it is a thin orchestrator on top of `ctx.ai` and
 * the OntologyRegistry.
 *
 * Pipeline (Spec 52 §2.1, §2.2):
 *  1. Build an action catalog from the OntologyRegistry, scoped by the
 *     caller's filters.
 *  2. Send a system prompt + the user message to the AI service.
 *  3. Parse + validate the AI response with Zod.
 *  4. Cross-validate the proposed input against the actual action's input
 *     schema (drop unknown fields, surface required-but-missing fields).
 *  5. Return an ActionProposal, or null when the confidence is below
 *     MIN_CONFIDENCE — never invent an action.
 *
 * Hard rule: this function NEVER executes the proposed action. AI proposes,
 * user confirms, CommandLayer executes (Spec 52 §1.1).
 */

import type { ActionDefinition, AIService, AITraceContext } from "@linchkit/core";
import { z } from "zod";
import { type ActionCatalogEntry, buildIntentSystemPrompt } from "./intent-prompt";

// ── Public types ─────────────────────────────────────────────

/**
 * A single proposed action ready to render in an Action Proposal Card.
 * The proposal is data only — execution happens through the standard
 * Action endpoint after the user confirms.
 */
export interface ActionProposal {
  /** Matched action name (always non-empty for a proposal). */
  action: string;
  /** Pre-filled input parameters validated against the action's schema. */
  input: Record<string, unknown>;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Required fields the AI did not fill — UI should prompt for these. */
  missingFields: string[];
  /** Human-readable summary suitable for UI display. */
  explanation: string;
  /** Optional N-best alternatives (not produced by the Phase 0 PoC). */
  alternatives?: ActionProposal[];
}

/** Caller-supplied input to the resolver. */
export interface ResolveIntentInput {
  /** Raw natural-language message from the user. */
  prompt: string;
  /** Optional scoping to narrow the candidate action set. */
  scope?: {
    /** When set, only actions on these entities are considered. */
    entityFilter?: string[];
    /** When set, only actions whose name appears here are considered. */
    actionFilter?: string[];
  };
  /** Tenant id forwarded to the AI service for BYOK config resolution. */
  tenant?: string;
  /** Calling user id — currently logged for traceability only. */
  userId?: string;
  /**
   * Model alias / id forwarded to `ai.complete()`. When unset, the AIService
   * picks its configured default. Surfaced so the eval framework (spec 69)
   * can record proposals against an explicitly-pinned model rather than
   * whatever the provider happens to default to.
   */
  model?: string;
  /**
   * Optional AI tracing context (Spec 69 Phase 3) forwarded verbatim to
   * `ai.complete()`. Lets the eval framework attribute the resolver's AI call
   * to a scenario / fixture / eval-run with the right redaction origin. When
   * unset no extra tracing metadata is attached (ambient tracing still
   * applies).
   */
  trace?: AITraceContext;
}

/**
 * Structural type describing the OntologyRegistry surface this resolver uses.
 * Kept minimal so callers can pass either the real OntologyRegistry or a
 * lightweight fake in tests.
 */
export interface OntologyRegistryLike {
  listEntities(): string[];
  actionsFor(entityName: string): ActionDefinition[];
}

/** Dependencies injected by the caller. */
export interface ResolveIntentDeps {
  /** AI service instance, typically `ctx.ai` from cap-ai-provider. */
  ai: AIService;
  /** Ontology source — only the methods in OntologyRegistryLike are used. */
  ontology: OntologyRegistryLike;
}

// ── Tunables ─────────────────────────────────────────────────

/**
 * Minimum confidence required to return a proposal. Below this we return
 * null and let the caller ask the user a clarifying question instead of
 * guessing. Picked at 0.4 to match Spec 52 §2.2 step 5 ("If confidence
 * < 0.4, respond with clarification question instead of action proposal").
 */
export const MIN_CONFIDENCE = 0.4;

/**
 * Confidence threshold below which the resolver surfaces N-best alternatives
 * for the UI to render as "Did you mean..." chips (Spec 52 §2.2 step 4).
 * At or above this threshold the primary match is confident enough that
 * alternatives are not shown.
 */
export const ALTERNATIVES_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Maximum number of alternatives surfaced alongside the primary proposal.
 * Caps Spec 52 §2.2 step 4 "Did you mean..." UI chips at a sane number.
 */
export const MAX_ALTERNATIVES = 3;

// ── AI response schema ───────────────────────────────────────

/**
 * One alternative match entry. Mirrors the primary fields exactly — no
 * nested alternatives. Tolerated as `unknown` parsed into a flat shape,
 * since downstream reconciliation re-validates against the catalog.
 */
const aiAlternativeSchema = z.object({
  action: z.string(),
  input: z.record(z.string(), z.unknown()).optional().default({}),
  confidence: z.number(),
  explanation: z.string().optional().default(""),
});

const aiResponseSchema = z.object({
  action: z.string().nullable(),
  input: z.record(z.string(), z.unknown()).optional().default({}),
  confidence: z.number(),
  explanation: z.string().optional().default(""),
  // Alternatives are optional; each entry is independently validated and
  // filtered by reconcileAlternatives() against the scoped catalog.
  alternatives: z.array(z.unknown()).optional(),
});

type AiResponse = z.infer<typeof aiResponseSchema>;
type AiAlternative = z.infer<typeof aiAlternativeSchema>;

// ── Public API ───────────────────────────────────────────────

/**
 * Resolve a natural-language prompt to a single ActionProposal, or null
 * when no usable proposal can be produced.
 *
 * Returns null when:
 *  - the prompt is empty / whitespace-only,
 *  - no candidate actions remain after applying scope filters,
 *  - the AI cannot match any action,
 *  - the AI selects an action that does not exist in the (scoped) catalog,
 *  - the AI response is malformed JSON or fails schema validation,
 *  - the resulting confidence is below MIN_CONFIDENCE.
 */
export async function resolveIntent(
  input: ResolveIntentInput,
  deps: ResolveIntentDeps,
): Promise<ActionProposal | null> {
  const trimmedPrompt = input.prompt.trim();
  if (trimmedPrompt.length === 0) {
    return null;
  }

  const catalog = buildActionCatalog(deps.ontology, input.scope);
  if (catalog.length === 0) {
    return null;
  }

  const catalogIndex = new Map(catalog.map((entry) => [entry.name, entry]));

  // Call AI — text completion + manual JSON parsing keeps us compatible
  // with the simplest AiService shape (no JSON-mode dependency).
  // Pass the threshold + cap as parameters so the prompt copy stays in
  // lockstep with the constants enforced at runtime by reconcileAlternatives.
  const systemPrompt = buildIntentSystemPrompt(catalog, {
    alternativesConfidenceThreshold: ALTERNATIVES_CONFIDENCE_THRESHOLD,
    maxAlternatives: MAX_ALTERNATIVES,
  });
  let rawContent: string;
  try {
    const result = await deps.ai.complete({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: trimmedPrompt },
      ],
      temperature: 0,
      tenantId: input.tenant,
      // Only forward `model` when the caller pinned one — otherwise the
      // AIService picks its configured default.
      ...(input.model ? { model: input.model } : {}),
      // Forward the tracing context so the recorded generation carries the
      // scenario / fixture / eval-run provenance (Spec 69 Phase 3).
      ...(input.trace ? { trace: input.trace } : {}),
    });
    rawContent = result.content;
  } catch {
    // AI service unavailable / threw — graceful degradation per Spec 52 §1.1.
    return null;
  }

  const parsed = parseAiResponse(rawContent);
  if (!parsed) {
    return null;
  }

  if (!parsed.action) {
    return null;
  }

  const catalogEntry = catalogIndex.get(parsed.action);
  if (!catalogEntry) {
    // AI proposed an action outside the (scoped) catalog. Refuse rather
    // than route a request the user did not consent to.
    return null;
  }

  const confidence = clampConfidence(parsed.confidence);
  if (confidence < MIN_CONFIDENCE) {
    return null;
  }

  const { input: cleanedInput, missingFields } = reconcileInput(catalogEntry, parsed.input ?? {});

  // Spec 52 §2.2 step 4 — surface N-best alternatives only when the
  // primary match is uncertain. Above the threshold the AI is confident
  // enough that "Did you mean..." UI chips would be noise.
  const alternatives =
    confidence < ALTERNATIVES_CONFIDENCE_THRESHOLD
      ? reconcileAlternatives(parsed.alternatives, catalogIndex, catalogEntry.name)
      : undefined;

  return {
    action: catalogEntry.name,
    input: cleanedInput,
    confidence,
    missingFields,
    explanation: parsed.explanation || `Proposed action: ${catalogEntry.name}`,
    ...(alternatives && alternatives.length > 0 ? { alternatives } : {}),
  };
}

// ── Catalog construction ────────────────────────────────────

function buildActionCatalog(
  ontology: OntologyRegistryLike,
  scope: ResolveIntentInput["scope"],
): ActionCatalogEntry[] {
  const entityFilter = toFilterSet(scope?.entityFilter);
  const actionFilter = toFilterSet(scope?.actionFilter);

  const seen = new Set<string>();
  const catalog: ActionCatalogEntry[] = [];

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

function toCatalogEntry(action: ActionDefinition): ActionCatalogEntry {
  const inputFields: ActionCatalogEntry["inputFields"] = [];
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

// ── Response parsing & reconciliation ───────────────────────

/**
 * Parse the AI's raw response into the validated AiResponse shape.
 * Returns null when the response is not valid JSON or fails schema checks.
 *
 * Be tolerant of common stylistic deviations:
 *  - leading / trailing whitespace
 *  - Markdown code fences (```json ... ```)
 *  - extra prose before / after the JSON object
 */
function parseAiResponse(raw: string): AiResponse | null {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) return null;

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return null;
  }

  const result = aiResponseSchema.safeParse(json);
  if (!result.success) return null;
  return result.data;
}

function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Strip Markdown code fences if present.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  // Fast path: looks like a JSON object already.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  // Prefer the FIRST balanced JSON object — robust against prose wrapping
  // and embedded JSON examples inside string fields like `explanation`.
  const balanced = extractFirstJsonObject(trimmed);
  if (balanced) return balanced;

  // Fall back to the legacy first/last brace heuristic for inputs the
  // string-aware scanner couldn't reconcile (e.g. truncated streams that
  // still happen to JSON.parse via prior tolerant parsers).
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

/**
 * Walk `text` once and return the first balanced top-level JSON object as
 * a substring (inclusive of the outer braces), or `null` if no balanced
 * object exists.
 *
 * Tracks brace depth while ignoring `{` / `}` that appear inside string
 * literals. Honors `\\` and `\"` escapes inside strings so an escaped quote
 * does not accidentally close the string scanner.
 *
 * Intentionally simple — no JSON5, no regex backtracking. The output is
 * still passed to `JSON.parse`, which is the source of truth for structural
 * validity.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escapeNext) {
        // Previous char was a backslash — consume this char literally,
        // even if it is a quote.
        escapeNext = false;
        continue;
      }
      if (ch === "\\") {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      if (depth < 0) {
        // Unbalanced — bail out rather than return a malformed slice.
        return null;
      }
    }
  }

  // Reached end of input without closing the outer object.
  return null;
}

interface ReconciledInput {
  input: Record<string, unknown>;
  missingFields: string[];
}

/**
 * Cross-validate the AI-proposed input against the action's catalog entry:
 *  - drop fields the AI invented that don't exist on the action,
 *  - report required fields the AI didn't fill (so the UI can prompt).
 *
 * Note: this PoC does NOT type-coerce values (AI returns numbers as numbers,
 * strings as strings). Type-level validation happens later when the action
 * actually executes.
 */
function reconcileInput(
  entry: ActionCatalogEntry,
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
    // `undefined` (absent) and `null` are always missing. `""` is missing
    // unless the field opts in via `allowEmpty: true` (Spec 52 #262 item 3).
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

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ── Alternatives reconciliation ─────────────────────────────

/**
 * Validate, allowlist, deduplicate, sort, and cap the AI-proposed
 * alternatives list. Spec 52 §2.2 step 4.
 *
 * For each raw entry we:
 *  - validate the shape via aiAlternativeSchema (drops anything malformed),
 *  - require the action exists in the (scoped) catalog (drops out-of-scope),
 *  - skip the primary action's own name to avoid duplication,
 *  - reconcile its input against the action's catalog entry,
 *  - clamp its confidence to [0, 1].
 *
 * Output is sorted by confidence descending and capped at MAX_ALTERNATIVES.
 * Returns undefined when no usable alternatives remain so the caller can
 * decide between "omit field" vs "empty array".
 */
function reconcileAlternatives(
  rawAlternatives: unknown[] | undefined,
  catalogIndex: Map<string, ActionCatalogEntry>,
  primaryActionName: string,
): ActionProposal[] | undefined {
  if (!rawAlternatives || rawAlternatives.length === 0) return undefined;

  const seen = new Set<string>([primaryActionName]);
  const reconciled: ActionProposal[] = [];

  for (const raw of rawAlternatives) {
    const parsedAlt = aiAlternativeSchema.safeParse(raw);
    if (!parsedAlt.success) continue;
    const alt: AiAlternative = parsedAlt.data;

    if (seen.has(alt.action)) continue;
    const catalogEntry = catalogIndex.get(alt.action);
    if (!catalogEntry) continue;

    // Drop alternatives that themselves fall below MIN_CONFIDENCE — they
    // would only show up in the UI's "Did you mean..." chips as low-quality
    // noise. Mirrors the Spec 52 §2.2 step 5 floor applied to the primary.
    const altConfidence = clampConfidence(alt.confidence);
    if (altConfidence < MIN_CONFIDENCE) continue;

    const { input: cleanedInput, missingFields } = reconcileInput(catalogEntry, alt.input ?? {});

    seen.add(catalogEntry.name);
    reconciled.push({
      action: catalogEntry.name,
      input: cleanedInput,
      confidence: altConfidence,
      missingFields,
      explanation: alt.explanation || `Proposed action: ${catalogEntry.name}`,
    });
  }

  if (reconciled.length === 0) return undefined;

  reconciled.sort((a, b) => b.confidence - a.confidence);
  return reconciled.slice(0, MAX_ALTERNATIVES);
}
