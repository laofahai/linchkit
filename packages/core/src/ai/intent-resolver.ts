/**
 * Intent Resolver — Pure NL → Intent function (Spec 52 §2.2 / §2.5).
 *
 * Canonical, provider-agnostic resolver turning a user utterance +
 * ontology snapshot into a discriminated `Intent` (see `intent-types.ts`).
 *
 * Pipeline: sanitize → build catalog → build system prompt (intent-prompt.ts)
 * → call provider → parse AI JSON → reconcile against catalog → emit
 * `Intent` (match / multi_step / clarification / no_match).
 *
 * Hard rule (Spec 52 §1.1): NEVER executes the proposed action; the caller
 * presents a confirmation card and routes confirmed proposals through
 * `POST /api/actions/:name`.
 *
 * Security posture:
 *  - Prompt injection: `sanitizePrompt()` runs on the utterance; catalog
 *    metadata is serialized as JSON (data, not instructions); the system
 *    prompt tells the model to ignore embedded instructions.
 *  - Action allowlist: post-validation catalog allowlist drops any action
 *    not in the scoped catalog even after a successful jailbreak.
 *  - Input allowlist: invented fields are dropped before the proposal is
 *    returned.
 *  - History: only the last N (default 6) user/assistant turns are
 *    forwarded as chat-role messages — never concatenated into the
 *    system prompt — so a prior-turn jailbreak cannot overwrite rules.
 */

import type { ActionDefinition } from "../types/action";
import type { AIMessage, AIService } from "../types/ai";
import {
  type AiResponse,
  buildIntentSystemPrompt,
  type IntentCatalogEntry,
  inferKind,
  parseAiResponse,
} from "./intent-prompt";
import type {
  Intent,
  IntentAlternative,
  IntentHistoryMessage,
  IntentResolverOptions,
  IntentSlot,
  IntentStep,
} from "./intent-types";
import { sanitizePrompt } from "./prompt-sanitizer";

// Re-export the JSON extractor for downstream consumers that want to
// reuse the same tolerant parser without depending on the prompt module.
export { extractFirstJsonObject } from "./intent-prompt";

// ── Tunable defaults (mirrored in IntentResolverOptions) ────

/** Default confidence floor (Spec 52 §2.2 step 5). */
export const MIN_CONFIDENCE = 0.4;

/** Default alternatives threshold (Spec 52 §2.2 step 4). */
export const ALTERNATIVES_CONFIDENCE_THRESHOLD = 0.7;

/** Cap on alternatives surfaced alongside the primary. */
export const MAX_ALTERNATIVES = 3;

/** Default history messages forwarded to the AI. */
export const DEFAULT_MAX_HISTORY_MESSAGES = 6;

// ── User-facing messages (i18n hook) ────────────────────────

/**
 * Default English message catalog for resolver outcomes surfaced to the UI.
 *
 * Full per-request i18n of resolver output is tracked as a follow-up — the
 * resolver receives no locale today, so wiring i18next here would require
 * a wider call-site refactor. As an interim step we centralize every
 * user-visible string the resolver emits so callers (or future locale-aware
 * wrappers) can override them in one place instead of grepping the file.
 *
 * Note: the `message` field on `IntentNoMatch` is documented as
 * human-readable; downstream UIs typically render their own copy keyed
 * off `reason`, so this catalog is a backstop rather than a UX surface.
 */
export const INTENT_RESOLVER_MESSAGES = {
  emptyUtterance: "Utterance is empty; nothing to resolve.",
  blockedBySanitizer: "Utterance blocked by prompt sanitizer (possible injection attempt).",
  noActionsInScope: "No actions are available in the requested scope.",
  aiUnavailable: "AI provider unavailable.",
  aiUnavailableWithMessage: (message: string) => `AI provider error: ${message}`,
  aiMalformedResponse: "AI returned malformed JSON; could not parse intent.",
  aiReturnedNoAction: "AI returned no action.",
  aiNoMatch: "AI could not match any listed action.",
  unknownAction: (action: string) => `AI proposed unknown action "${action}".`,
  multiStepNoUsableSteps: "AI returned multi_step with no usable steps.",
  multiStepUnknownAction: (action: string) =>
    `Multi-step sequence referenced unknown action "${action}".`,
  singleStepUnknownAction: (action: string) =>
    `Single-step fallback referenced unknown action "${action}".`,
  multiStepLowConfidenceClarification:
    "I think you want to perform multiple steps but I'm not sure. Could you clarify?",
  matchLowConfidenceClarification: (explanation: string) =>
    explanation && explanation.length > 0
      ? `${explanation} Could you clarify which action you want?`
      : "I'm not sure which action you meant. Could you rephrase?",
  singleStepFallbackClarification: "Could you confirm what you want to do?",
  fallbackClarification: "Could you clarify which action you want to perform?",
  defaultMatchExplanation: (action: string) => `Proposed action: ${action}`,
  defaultMultiStepExplanation: (stepCount: number) => `Sequence of ${stepCount} actions`,
  defaultStepExplanation: (oneBasedIndex: number, action: string) =>
    `Step ${oneBasedIndex}: ${action}`,
} as const;

export type IntentResolverMessages = typeof INTENT_RESOLVER_MESSAGES;

// ── Ontology shape (structural, dependency-light) ───────────

/**
 * Minimal `OntologyRegistry` projection the resolver depends on. Kept
 * structural so callers can pass either the real registry or a fake.
 */
export interface IntentOntology {
  listEntities(): string[];
  actionsFor(entityName: string): ActionDefinition[];
}

// ── Input ─────────────────────────────────────────────────────

/** Caller-supplied input to `resolveIntent()`. */
export interface ResolveIntentInput {
  /** Raw natural-language utterance from the user. */
  utterance: string;
  /** Conversation history forwarded to the AI (latest N kept). */
  history?: readonly IntentHistoryMessage[];
  /** Optional scope narrowing the candidate action set. */
  scope?: {
    /** When set, only actions on these entities are considered. */
    entityFilter?: readonly string[];
    /** When set, only actions with these names are considered. */
    actionFilter?: readonly string[];
  };
  /** Tenant id forwarded to the AI service (BYOK provider config). */
  tenantId?: string;
  /** Calling user id — logged downstream for traceability. */
  userId?: string;
  /** Resolver tuning knobs. */
  options?: IntentResolverOptions;
}

/** Dependencies injected by the caller. */
export interface ResolveIntentDeps {
  /** AI service instance (typically `ctx.ai`). */
  provider: AIService;
  /** Ontology source — only the methods in `IntentOntology` are used. */
  ontology: IntentOntology;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Resolve a natural-language utterance into a discriminated `Intent`.
 *
 * Never throws — every failure path returns an `IntentNoMatch` with a
 * machine-readable `reason`, so the caller can render a graceful UI
 * state instead of exception handling.
 */
export async function resolveIntent(
  input: ResolveIntentInput,
  deps: ResolveIntentDeps,
): Promise<Intent> {
  const options = input.options ?? {};
  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
  const altThreshold = options.alternativesThreshold ?? ALTERNATIVES_CONFIDENCE_THRESHOLD;
  const maxAlternatives = options.maxAlternatives ?? MAX_ALTERNATIVES;
  // Clamp to a non-negative integer. `maxHistoryMessages: 0` MUST mean
  // "forward no history" — left unguarded, `slice(-0)` is `slice(0)` which
  // forwards the whole transcript and silently leaks every prior turn to
  // the provider, breaking both the option contract and the security
  // posture documented at the top of this file.
  const rawMaxHistory = options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const maxHistory =
    Number.isFinite(rawMaxHistory) && rawMaxHistory > 0 ? Math.floor(rawMaxHistory) : 0;
  const sanitize = options.sanitizeUtterance ?? true;

  // Step 1 — Sanitize the utterance.
  const rawUtterance = input.utterance ?? "";
  const trimmed = rawUtterance.trim();
  if (trimmed.length === 0) {
    return {
      kind: "no_match",
      reason: "empty_utterance",
      message: INTENT_RESOLVER_MESSAGES.emptyUtterance,
    };
  }
  let utterance = trimmed;
  if (sanitize) {
    const result = sanitizePrompt(trimmed);
    if (result.blocked) {
      return {
        kind: "no_match",
        reason: "blocked_by_sanitizer",
        message: result.blockReason ?? INTENT_RESOLVER_MESSAGES.blockedBySanitizer,
      };
    }
    utterance = result.sanitized;
  }

  // Step 2 — Build the catalog.
  const catalog = buildCatalog(deps.ontology, input.scope);
  if (catalog.length === 0) {
    return {
      kind: "no_match",
      reason: "no_actions_in_scope",
      message: INTENT_RESOLVER_MESSAGES.noActionsInScope,
    };
  }
  const catalogIndex = new Map(catalog.map((entry) => [entry.name, entry]));

  // Steps 3-4 — Build system prompt + compose chat messages.
  const systemPrompt = buildIntentSystemPrompt(catalog, {
    minConfidence,
    alternativesThreshold: altThreshold,
    maxAlternatives,
  });
  const messages: AIMessage[] = [{ role: "system", content: systemPrompt }];
  if (maxHistory > 0 && input.history && input.history.length > 0) {
    const tail = input.history.slice(-maxHistory);
    for (const msg of tail) {
      const rawContent = typeof msg.content === "string" ? msg.content : "";
      const trimmedContent = rawContent.trim();
      if (trimmedContent.length === 0) continue;
      // Historical turns are still user/model-controlled text. Without
      // re-sanitization a stored prompt-injection attempt from an earlier
      // turn would slip past `sanitize` (which only runs on the current
      // utterance) and steer the resolver from inside the chat transcript.
      // When sanitization is disabled (trusted callers — tests / MCP) we
      // preserve the original content unchanged, matching the contract for
      // the live utterance above.
      if (sanitize) {
        const result = sanitizePrompt(trimmedContent);
        // Blocked turns are dropped — never forwarded to the provider. A
        // partial transcript is preferable to surfacing jailbreak content.
        if (result.blocked) continue;
        messages.push({ role: msg.role, content: result.sanitized });
      } else {
        messages.push({ role: msg.role, content: trimmedContent });
      }
    }
  }
  messages.push({ role: "user", content: utterance });

  // Step 5 — Call the AI. Any throw is graceful degradation.
  let rawContent: string;
  try {
    const result = await deps.provider.complete({
      messages,
      temperature: 0,
      tenantId: input.tenantId,
    });
    rawContent = result.content;
  } catch (err) {
    return {
      kind: "no_match",
      reason: "ai_unavailable",
      message:
        err instanceof Error
          ? INTENT_RESOLVER_MESSAGES.aiUnavailableWithMessage(err.message)
          : INTENT_RESOLVER_MESSAGES.aiUnavailable,
    };
  }

  // Step 6 — Parse + validate.
  const parsed = parseAiResponse(rawContent);
  if (!parsed) {
    return {
      kind: "no_match",
      reason: "ai_malformed_response",
      message: INTENT_RESOLVER_MESSAGES.aiMalformedResponse,
    };
  }

  // Step 7 — Branch on the AI-declared (or inferred) `kind`.
  const kind = inferKind(parsed);
  switch (kind) {
    case "no_match":
      return {
        kind: "no_match",
        reason: "no_action_matched",
        message: parsed.explanation || INTENT_RESOLVER_MESSAGES.aiNoMatch,
      };
    case "clarification":
      return buildClarification(parsed, catalogIndex, maxAlternatives);
    case "multi_step":
      return buildMultiStep(parsed, catalogIndex, minConfidence);
    case "match":
      return buildMatch(parsed, catalogIndex, {
        minConfidence,
        altThreshold,
        maxAlternatives,
      });
  }
}

// ── Catalog construction ────────────────────────────────────

function buildCatalog(
  ontology: IntentOntology,
  scope: ResolveIntentInput["scope"],
): IntentCatalogEntry[] {
  const entityFilter = toFilterSet(scope?.entityFilter);
  const actionFilter = toFilterSet(scope?.actionFilter);
  const seen = new Set<string>();
  const catalog: IntentCatalogEntry[] = [];
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

function toCatalogEntry(action: ActionDefinition): IntentCatalogEntry {
  const inputFields: IntentCatalogEntry["inputFields"] = [];
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

/**
 * Convert a filter list to a Set, distinguishing "unset" (undefined) from
 * "explicitly empty" ([]). An empty array means "no candidates allowed" and
 * MUST produce an empty Set so the caller short-circuits to an empty catalog
 * — collapsing it to `undefined` would silently widen scope and re-admit the
 * full ontology, which is a security/correctness regression.
 */
function toFilterSet(values: readonly string[] | undefined): Set<string> | undefined {
  if (values === undefined) return undefined;
  return new Set(values);
}

// ── Reconciliation helpers ──────────────────────────────────

interface ReconciledInput {
  input: Record<string, unknown>;
  missingFields: string[];
}

function reconcileInput(
  entry: IntentCatalogEntry,
  proposed: Record<string, unknown>,
): ReconciledInput {
  const known = new Map(entry.inputFields.map((f) => [f.name, f]));
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(proposed)) {
    if (!known.has(key)) continue;
    if (value === undefined) continue;
    cleaned[key] = value;
  }
  const missing: string[] = [];
  for (const field of entry.inputFields) {
    if (!field.required) continue;
    const value = cleaned[field.name];
    if (value === undefined || value === null) {
      missing.push(field.name);
      continue;
    }
    if (value === "" && field.allowEmpty !== true) {
      missing.push(field.name);
    }
  }
  return { input: cleaned, missingFields: missing };
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function reconcileAlternatives(
  raw: unknown[] | undefined,
  catalogIndex: Map<string, IntentCatalogEntry>,
  excludeAction: string | null,
  minConfidence: number,
  maxAlternatives: number,
): IntentAlternative[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const seen = new Set<string>();
  if (excludeAction) seen.add(excludeAction);
  const out: IntentAlternative[] = [];
  for (const item of raw) {
    // Mirror aiAlternativeSchema inline (avoids importing a heavyweight
    // helper just to safe-parse one record) — the structural shape is
    // tiny and stable.
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.action !== "string") continue;
    if (typeof rec.confidence !== "number") continue;
    const altAction = rec.action;
    if (seen.has(altAction)) continue;
    const entry = catalogIndex.get(altAction);
    if (!entry) continue;
    const confidence = clampConfidence(rec.confidence);
    if (confidence < minConfidence) continue;
    const altInputRaw = rec.input;
    const altInput =
      altInputRaw && typeof altInputRaw === "object"
        ? (altInputRaw as Record<string, unknown>)
        : {};
    const { input, missingFields } = reconcileInput(entry, altInput);
    const explanation = typeof rec.explanation === "string" ? rec.explanation : "";
    seen.add(entry.name);
    out.push({
      action: entry.name,
      entity: entry.entity,
      input,
      confidence,
      explanation: explanation || INTENT_RESOLVER_MESSAGES.defaultMatchExplanation(entry.name),
      missingFields,
    });
  }
  if (out.length === 0) return undefined;
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, maxAlternatives);
}

// ── Branch builders ─────────────────────────────────────────

function buildMatch(
  parsed: AiResponse,
  catalogIndex: Map<string, IntentCatalogEntry>,
  opts: { minConfidence: number; altThreshold: number; maxAlternatives: number },
): Intent {
  if (!parsed.action) {
    return {
      kind: "no_match",
      reason: "no_action_matched",
      message: parsed.explanation || INTENT_RESOLVER_MESSAGES.aiReturnedNoAction,
    };
  }
  const entry = catalogIndex.get(parsed.action);
  if (!entry) {
    return {
      kind: "no_match",
      reason: "no_action_matched",
      message: INTENT_RESOLVER_MESSAGES.unknownAction(parsed.action),
    };
  }
  const confidence = clampConfidence(parsed.confidence);

  // Below the confidence floor → demote to clarification (Spec 52 §2.2 step 5).
  if (confidence < opts.minConfidence) {
    const candidates = reconcileAlternatives(
      parsed.alternatives,
      catalogIndex,
      null,
      opts.minConfidence,
      opts.maxAlternatives,
    );
    return {
      kind: "clarification",
      question: INTENT_RESOLVER_MESSAGES.matchLowConfidenceClarification(parsed.explanation ?? ""),
      candidates,
      bestConfidence: confidence,
    };
  }

  const { input, missingFields } = reconcileInput(entry, parsed.input ?? {});
  const slots = buildSlots(parsed.slots, input);
  const alternatives =
    confidence < opts.altThreshold
      ? reconcileAlternatives(
          parsed.alternatives,
          catalogIndex,
          entry.name,
          opts.minConfidence,
          opts.maxAlternatives,
        )
      : undefined;

  return {
    kind: "match",
    action: entry.name,
    entity: entry.entity,
    input,
    slots,
    missingFields,
    confidence,
    explanation: parsed.explanation || INTENT_RESOLVER_MESSAGES.defaultMatchExplanation(entry.name),
    ...(alternatives && alternatives.length > 0 ? { alternatives } : {}),
  };
}

function buildSlots(
  raw: Array<{ name: string; value: unknown; source?: string }> | undefined,
  reconciledInput: Record<string, unknown>,
): IntentSlot[] {
  // Always clamp to the reconciled input map so a hallucinated slot can't
  // smuggle a dropped field back into the caller.
  if (!raw || raw.length === 0) {
    return Object.entries(reconciledInput).map(([name, value]) => ({ name, value }));
  }
  const out: IntentSlot[] = [];
  const seen = new Set<string>();
  for (const slot of raw) {
    if (!Object.hasOwn(reconciledInput, slot.name)) continue;
    if (seen.has(slot.name)) continue;
    seen.add(slot.name);
    out.push({
      name: slot.name,
      value: reconciledInput[slot.name],
      source: slot.source,
    });
  }
  // Backfill any reconciled field the AI didn't tag with provenance.
  for (const [name, value] of Object.entries(reconciledInput)) {
    if (seen.has(name)) continue;
    out.push({ name, value });
  }
  return out;
}

function buildMultiStep(
  parsed: AiResponse,
  catalogIndex: Map<string, IntentCatalogEntry>,
  minConfidence: number,
): Intent {
  const rawSteps = parsed.steps ?? [];

  // <2 steps: try single-match fallback (1 step) or no_match (0 steps).
  if (rawSteps.length < 2) {
    return rawSteps.length === 1
      ? buildSingleStepFallback(rawSteps[0], parsed, catalogIndex, minConfidence)
      : {
          kind: "no_match",
          reason: "no_action_matched",
          message: INTENT_RESOLVER_MESSAGES.multiStepNoUsableSteps,
        };
  }

  const steps: IntentStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i];
    if (!raw) continue;
    const entry = catalogIndex.get(raw.action);
    if (!entry) {
      // Hallucinated step action — refuse the whole sequence.
      return {
        kind: "no_match",
        reason: "no_action_matched",
        message: INTENT_RESOLVER_MESSAGES.multiStepUnknownAction(raw.action),
      };
    }
    const { input, missingFields } = reconcileInput(entry, raw.input ?? {});
    const dependsOn =
      raw.dependsOn !== undefined && raw.dependsOn >= 0 && raw.dependsOn < i
        ? raw.dependsOn
        : undefined;
    steps.push({
      index: i,
      action: entry.name,
      entity: entry.entity,
      input,
      missingFields,
      explanation:
        raw.explanation || INTENT_RESOLVER_MESSAGES.defaultStepExplanation(i + 1, entry.name),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
    });
  }

  const confidence = clampConfidence(parsed.confidence);
  if (confidence < minConfidence) {
    return {
      kind: "clarification",
      question: INTENT_RESOLVER_MESSAGES.multiStepLowConfidenceClarification,
      bestConfidence: confidence,
    };
  }

  return {
    kind: "multi_step",
    steps,
    confidence,
    explanation:
      parsed.explanation || INTENT_RESOLVER_MESSAGES.defaultMultiStepExplanation(steps.length),
    // Default to saga unless the AI explicitly opted out.
    saga: parsed.saga ?? true,
  };
}

/** Helper: AI returned `multi_step` with exactly one step. Downgrade to match. */
function buildSingleStepFallback(
  only: NonNullable<AiResponse["steps"]>[number] | undefined,
  parsed: AiResponse,
  catalogIndex: Map<string, IntentCatalogEntry>,
  minConfidence: number,
): Intent {
  if (!only) {
    return {
      kind: "no_match",
      reason: "no_action_matched",
      message: INTENT_RESOLVER_MESSAGES.multiStepNoUsableSteps,
    };
  }
  const entry = catalogIndex.get(only.action);
  if (!entry) {
    return {
      kind: "no_match",
      reason: "no_action_matched",
      message: INTENT_RESOLVER_MESSAGES.singleStepUnknownAction(only.action),
    };
  }
  const { input, missingFields } = reconcileInput(entry, only.input ?? {});
  const confidence = clampConfidence(parsed.confidence);
  if (confidence < minConfidence) {
    return {
      kind: "clarification",
      question: INTENT_RESOLVER_MESSAGES.singleStepFallbackClarification,
      bestConfidence: confidence,
    };
  }
  return {
    kind: "match",
    action: entry.name,
    entity: entry.entity,
    input,
    slots: buildSlots(undefined, input),
    missingFields,
    confidence,
    explanation:
      only.explanation ||
      parsed.explanation ||
      INTENT_RESOLVER_MESSAGES.defaultMatchExplanation(entry.name),
  };
}

function buildClarification(
  parsed: AiResponse,
  catalogIndex: Map<string, IntentCatalogEntry>,
  maxAlternatives: number,
): Intent {
  const question =
    parsed.question && parsed.question.trim().length > 0
      ? parsed.question
      : INTENT_RESOLVER_MESSAGES.fallbackClarification;
  const candidates = reconcileAlternatives(
    parsed.candidates ?? parsed.alternatives,
    catalogIndex,
    null,
    0, // surface every plausible candidate — UI shows them as chips
    maxAlternatives,
  );
  return {
    kind: "clarification",
    question,
    candidates,
    bestConfidence: clampConfidence(parsed.confidence),
  };
}
