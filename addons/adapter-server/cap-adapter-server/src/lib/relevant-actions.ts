/**
 * Spec 52 Phase 1 hardening — relevance-based catalog pre-selection.
 *
 * The natural-language intent resolver feeds the AI a JSON catalog of every
 * action it might invoke. For real-world ontologies that catalog can be
 * hundreds of entries — blowing past the model's context window and burning
 * tokens. Issue #262 item 1 calls for a lightweight lexical pre-filter that
 * keeps only the entries plausibly relevant to the user's prompt.
 *
 * Algorithm (KISS — no embeddings, no NLP libs):
 *   1. Tokenize the prompt into lowercase word tokens.
 *   2. For each candidate (entity OR action) compute a score:
 *        +3 per exact word match in the candidate's `name` / `label`
 *        +2 per exact word match in `description`
 *        +1 per exact word match in field names (entities only)
 *        +0.5 per partial substring match (length >= 3)
 *   3. Order DESC by score, ties broken by original ontology order (stable).
 *   4. Keep top `maxEntities` entities; within each kept entity keep
 *      top `maxActionsPerEntity` actions.
 *
 * The function is PURE — no clock, no I/O — so it is trivially testable.
 *
 * NOTE: vector / embedding-based ranking is intentionally out of scope here;
 * that work belongs to issue #165 (cap-vector-pgvector). Lexical scoring is
 * good enough for Phase 1 and avoids a runtime dependency on embeddings.
 */

import type { ActionCatalogEntry } from "@linchkit/cap-ai-provider";

// ── Public types ─────────────────────────────────────────────

/**
 * The catalog shape consumed by the limiter. Matches the (already
 * permission-scoped) action list produced by the route before it is handed
 * to `resolveIntent()`. We deliberately reuse `ActionCatalogEntry` from
 * cap-ai-provider so the limiter operates on the same shape the resolver
 * already understands — no extra translation layer.
 */
export type RelevanceCatalog = readonly ActionCatalogEntry[];

export interface LimitCatalogToRelevantOptions {
  /** Full catalog of action entries. */
  catalog: RelevanceCatalog;
  /** Raw user prompt — used to derive scoring tokens. */
  prompt: string;
  /** Maximum number of distinct entities to keep. Defaults to 20. */
  maxEntities?: number;
  /** Maximum actions per kept entity. Defaults to 20. */
  maxActionsPerEntity?: number;
}

// ── Tunables ─────────────────────────────────────────────────

/** Default cap on distinct entities returned. Mirrors task spec for #262. */
export const DEFAULT_MAX_ENTITIES = 20;
/** Default per-entity action cap. */
export const DEFAULT_MAX_ACTIONS_PER_ENTITY = 20;

/** Minimum token length required to participate in substring matching. */
const MIN_PARTIAL_MATCH_LEN = 3;

// Score weights — tuned to the task spec.
const SCORE_NAME_MATCH = 3;
const SCORE_DESCRIPTION_MATCH = 2;
const SCORE_FIELD_MATCH = 1;
const SCORE_PARTIAL_MATCH = 0.5;

// ── Public API ───────────────────────────────────────────────

/**
 * Return a relevance-pruned subset of the catalog.
 *
 * Short-circuits when the catalog already has fewer than `maxEntities`
 * distinct entities OR the prompt yields zero tokens — in either case the
 * top-K-by-original-order projection is already correct, so we simply
 * apply the cap without scoring.
 *
 * The output preserves original ordering wherever possible (stable sort),
 * matching the resolver's existing assumption that the catalog order
 * mirrors `OntologyRegistry.listEntities()` order. This keeps the
 * downstream `actionFilter` allowlist deterministic across runs.
 */
export function limitCatalogToRelevant(
  options: LimitCatalogToRelevantOptions,
): ActionCatalogEntry[] {
  const maxEntities = options.maxEntities ?? DEFAULT_MAX_ENTITIES;
  const maxActionsPerEntity = options.maxActionsPerEntity ?? DEFAULT_MAX_ACTIONS_PER_ENTITY;

  const catalog = options.catalog;
  if (catalog.length === 0) return [];

  const grouped = groupByEntity(catalog);
  const tokens = tokenize(options.prompt);

  // Empty / whitespace-only prompt → fall back to original order at both
  // entity and per-entity action levels. No tokens → no scoring possible.
  if (tokens.length === 0) {
    const kept = grouped.slice(0, maxEntities);
    return flattenGroups(kept, (group) => group.actions.slice(0, maxActionsPerEntity));
  }

  // Entity-level fast path: nothing to truncate at the entity level. We
  // still rank actions WITHIN each entity — small entity counts can still
  // expose a single broad entity with hundreds of actions, and dropping
  // the 21st+ by original order would silently hide it from the resolver
  // even when the prompt clearly targets it (codex P1 review on #262).
  if (grouped.length <= maxEntities) {
    return flattenGroups(grouped, (group) =>
      pickTopActions(group.actions, tokens, maxActionsPerEntity),
    );
  }

  // Score each entity group; stable sort by score DESC.
  const scoredEntities = grouped.map((group, originalIndex) => ({
    group,
    originalIndex,
    score: scoreEntity(group, tokens),
  }));
  scoredEntities.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  const keptEntities = scoredEntities.slice(0, maxEntities);

  // Re-establish original ontology order before flattening so the resulting
  // action list mirrors `listEntities()` iteration. Within each entity we
  // score actions and keep the top-K (preserving original order on ties).
  keptEntities.sort((a, b) => a.originalIndex - b.originalIndex);

  return flattenGroups(
    keptEntities.map((e) => e.group),
    (group) => pickTopActions(group.actions, tokens, maxActionsPerEntity),
  );
}

// ── Internals ────────────────────────────────────────────────

interface EntityGroup {
  entity: string;
  /** Actions in their original ontology order. */
  actions: ActionCatalogEntry[];
}

/**
 * Group a flat catalog by entity name, preserving the FIRST-SEEN order of
 * both entities and actions. Stability is important — ties in scoring
 * fall back to this order so callers get a deterministic projection.
 */
function groupByEntity(catalog: RelevanceCatalog): EntityGroup[] {
  const indexByEntity = new Map<string, number>();
  const groups: EntityGroup[] = [];
  for (const entry of catalog) {
    let idx = indexByEntity.get(entry.entity);
    if (idx === undefined) {
      idx = groups.length;
      indexByEntity.set(entry.entity, idx);
      groups.push({ entity: entry.entity, actions: [] });
    }
    const group = groups[idx];
    if (group) group.actions.push(entry);
  }
  return groups;
}

function flattenGroups(
  groups: readonly EntityGroup[],
  selectActions: (group: EntityGroup) => ActionCatalogEntry[],
): ActionCatalogEntry[] {
  const out: ActionCatalogEntry[] = [];
  for (const group of groups) {
    for (const action of selectActions(group)) {
      out.push(action);
    }
  }
  return out;
}

/**
 * Tokenize a free-form prompt into lowercase word tokens. LinchKit
 * identifiers are snake_case by convention (`submit_purchase_request`),
 * so we treat `_` and `-` as token separators in addition to whitespace
 * and punctuation. This way a prompt like "submit purchase request"
 * matches the action name `submit_purchase_request` (codex P2 review on
 * #262 — preserving `_` made identifier scoring miss the most common
 * pattern). Unicode word characters are preserved via `\p{L}` / `\p{N}`
 * so non-ASCII identifiers still match.
 */
function tokenize(prompt: string): string[] {
  if (!prompt) return [];
  const lower = prompt.toLowerCase();
  // Split on anything that isn't a unicode letter or digit — dashes,
  // underscores, whitespace, and punctuation all separate tokens.
  const raw = lower.split(/[^\p{L}\p{N}]+/u);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length > 0) out.push(t);
  }
  return out;
}

/**
 * Score an entity group by combining entity-level signals (entity name
 * match, field name match across all actions on the entity) with the
 * MAX action-level score within the group. Taking the max — rather than
 * summing — prevents an entity with many trivially-matching actions from
 * dominating ranking when only one action actually matches.
 */
function scoreEntity(group: EntityGroup, tokens: readonly string[]): number {
  let score = 0;

  // Entity name signal — strongest, matches the algorithm's "+3 per word
  // match in name". We treat the entity name itself as the candidate
  // tokens (split on `_` and case boundaries).
  const entityTokens = candidateTokens(group.entity);
  score += SCORE_NAME_MATCH * countExactMatches(tokens, entityTokens);
  score += SCORE_PARTIAL_MATCH * countPartialMatches(tokens, entityTokens);

  // Field name signal across all actions on the entity (+1 per match).
  const fieldTokens = new Set<string>();
  for (const action of group.actions) {
    for (const field of action.inputFields) {
      for (const t of candidateTokens(field.name)) fieldTokens.add(t);
    }
  }
  if (fieldTokens.size > 0) {
    const fieldTokenList = Array.from(fieldTokens);
    score += SCORE_FIELD_MATCH * countExactMatches(tokens, fieldTokenList);
  }

  // Action-level signal: best action score within the entity. Acts as a
  // tie-breaker between entities whose names don't appear in the prompt
  // but which contain a strongly-matching action (e.g. prompt "approve
  // request" + action `approve_request` on entity `purchase_request`).
  let bestActionScore = 0;
  for (const action of group.actions) {
    const s = scoreAction(action, tokens);
    if (s > bestActionScore) bestActionScore = s;
  }
  score += bestActionScore;

  return score;
}

function scoreAction(action: ActionCatalogEntry, tokens: readonly string[]): number {
  let score = 0;

  const nameTokens = candidateTokens(action.name);
  const labelTokens = candidateTokens(action.label);
  const nameOrLabel = mergeUnique(nameTokens, labelTokens);
  score += SCORE_NAME_MATCH * countExactMatches(tokens, nameOrLabel);
  score += SCORE_PARTIAL_MATCH * countPartialMatches(tokens, nameOrLabel);

  if (action.description) {
    const descTokens = tokenize(action.description);
    score += SCORE_DESCRIPTION_MATCH * countExactMatches(tokens, descTokens);
  }

  return score;
}

/**
 * Pick the top-K actions within an entity group by relevance score,
 * stable on ties (preserving original order). When the group is already
 * smaller than K we still iterate (cheap) and return the head — no
 * special case needed.
 */
function pickTopActions(
  actions: readonly ActionCatalogEntry[],
  tokens: readonly string[],
  cap: number,
): ActionCatalogEntry[] {
  if (actions.length <= cap) {
    // Order preserved — no need to score when nothing is dropped.
    return actions.slice();
  }
  const scored = actions.map((action, originalIndex) => ({
    action,
    originalIndex,
    score: scoreAction(action, tokens),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });
  const kept = scored.slice(0, cap);
  // Restore original order so the action subset remains deterministic.
  kept.sort((a, b) => a.originalIndex - b.originalIndex);
  return kept.map((s) => s.action);
}

/**
 * Break an identifier into match-friendly tokens. Splits on `_`, `-`,
 * and case boundaries (camelCase). Always lowercased.
 */
function candidateTokens(identifier: string): string[] {
  if (!identifier) return [];
  // Insert spaces at lower→upper boundaries (camelCase / PascalCase).
  const spaced = identifier.replace(/([a-z\d])([A-Z])/g, "$1 $2");
  return tokenize(spaced);
}

function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a.slice();
  const seen = new Set(a);
  const out = a.slice();
  for (const t of b) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Count the number of (promptToken, candidateToken) exact matches across
 * the cross-product. Each prompt token can match multiple candidate
 * tokens — this rewards candidates that hit several distinct prompt
 * tokens simultaneously.
 */
function countExactMatches(
  promptTokens: readonly string[],
  candidateTokens: readonly string[],
): number {
  if (promptTokens.length === 0 || candidateTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  let count = 0;
  for (const p of promptTokens) {
    if (candidateSet.has(p)) count += 1;
  }
  return count;
}

/**
 * Count partial substring matches: a prompt token contained in a
 * candidate token (or vice versa) when both are at least
 * MIN_PARTIAL_MATCH_LEN characters. Exact matches are excluded so they
 * are not double-counted with `countExactMatches`.
 */
function countPartialMatches(
  promptTokens: readonly string[],
  candidateTokens: readonly string[],
): number {
  if (promptTokens.length === 0 || candidateTokens.length === 0) return 0;
  let count = 0;
  for (const p of promptTokens) {
    if (p.length < MIN_PARTIAL_MATCH_LEN) continue;
    for (const c of candidateTokens) {
      if (c.length < MIN_PARTIAL_MATCH_LEN) continue;
      if (p === c) continue; // exact match — counted elsewhere
      if (p.includes(c) || c.includes(p)) {
        count += 1;
        break; // one partial credit per prompt token
      }
    }
  }
  return count;
}
