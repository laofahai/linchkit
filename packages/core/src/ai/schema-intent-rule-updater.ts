/**
 * Schema Intent Resolver — Update-rule reconciliation + mint
 * (Spec 52 "describe-to-exists", update_rule slice).
 *
 * Extracted from `schema-intent-resolver.ts` so the resolver file stays under
 * the repo's 500-line ceiling and focuses on the pipeline (sanitize → call AI →
 * branch on kind). This module owns the `update_rule` reconciliation: it turns a
 * parsed `update_rule` intent into a governed `update_rule` draft Proposal,
 * mirroring the add_rule path's validation discipline.
 *
 * Security posture (same as the resolver doc): an `update_rule` may only target
 * a rule present in the ontology's rule list (allowlist — the AI cannot update
 * what it cannot see). A rule whose condition is CODE (or is otherwise not
 * round-trippable) carries NO fabricated definition — only a human-readable diff
 * summary, flagged `requiresCodeChange` (an honest, governed change REQUEST a
 * developer applies in source).
 */

import type { RuleDefinition } from "../types/rule";
import type { ProposalEngine } from "./proposal-engine";
import type { ParsedRuleShape, ParsedSchemaIntent } from "./schema-intent-prompt";
import { SCHEMA_INTENT_MESSAGES } from "./schema-intent-resolver-messages";
import { buildRuleDefinition } from "./schema-intent-rule-builder";
import type {
  SchemaIntentEntity,
  SchemaIntentOutcome,
  SchemaIntentRule,
} from "./schema-intent-types";

/** Build a no-match outcome with a stable reason code. */
function noMatch(
  reason: Extract<SchemaIntentOutcome, { kind: "no_match" }>["reason"],
  message: string,
): SchemaIntentOutcome {
  return { kind: "no_match", reason, message };
}

/**
 * Turn a parsed `update_rule` intent into a governed `update_rule` draft
 * Proposal, mirroring the add_rule path's validation discipline:
 *
 *  1. The targeted rule MUST exist on the entity's rule list (allowlist —
 *     the AI cannot update a rule it was not shown).
 *  2. Round-trippable declarative rule: the AI's FULL updated definition
 *     passes the same strict structural validation as add_rule
 *     (`buildRuleDefinition`); `priority` and unchanged effect fields are
 *     BACK-FILLED from the existing snapshot (robust against AI omissions),
 *     and the name is pinned to the existing rule's name (renames out of
 *     scope) — re-pinned AFTER the build so name normalization can never
 *     diverge from the registered name.
 *  3. Non-round-trippable rule (CODE condition, composite/not condition,
 *     non-action trigger, non-declarative effect): the builder cannot rebuild
 *     the definition faithfully, so none is fabricated. The draft carries
 *     ONLY the human-readable diff summary and is flagged
 *     `requiresCodeChange` — an honest, governed change REQUEST a developer
 *     applies in source. Such an update without any diff/explanation is
 *     refused (there is nothing actionable to review).
 */
export function draftRuleUpdate(opts: {
  parsed: ParsedSchemaIntent;
  entity: SchemaIntentEntity;
  confidence: number;
  utterance: string;
  engine: ProposalEngine;
}): SchemaIntentOutcome {
  const { parsed, entity, confidence, utterance, engine } = opts;

  const targetRuleName = (parsed.ruleName ?? "").trim();
  const existing = (entity.rules ?? []).find((rule) => rule.name === targetRuleName);
  if (!existing) {
    return noMatch("unknown_rule", SCHEMA_INTENT_MESSAGES.unknownRule(targetRuleName, entity.name));
  }

  const explanation =
    parsed.explanation?.trim() || `Update rule "${existing.name}" on ${entity.name}`;
  const diffSummary = parsed.diff?.trim() || "";

  // Diff-only path: code-backed rules AND declarative rules the builder
  // cannot rebuild faithfully (composite/not conditions, non-action triggers,
  // non-declarative effects — `roundTrippable: false` in the snapshot). A
  // declarative rebuild of those would silently flatten conjuncts or swap the
  // trigger kind, so the honest draft carries the diff summary only.
  if (existing.conditionKind === "code" || existing.roundTrippable === false) {
    // Honest path for non-round-trippable rules: no fabricated definition.
    const summary = diffSummary || parsed.explanation?.trim() || "";
    if (!summary) {
      return noMatch("invalid_rule", SCHEMA_INTENT_MESSAGES.missingUpdateDiff);
    }
    const proposal = engine.createProposal({
      type: "update_rule",
      description: explanation,
      reasoning: utterance,
      confidence,
      // NO definition — the rule cannot be rebuilt faithfully from what the
      // AI saw. The summary is the reviewable spec of the change.
      // `targetName` carries the rule name so downstream security change
      // records still report the real target without a definition.
      diff: { target: "rule", operation: "update", targetName: existing.name, summary },
    });
    return {
      kind: "proposal_draft",
      proposal,
      operation: "update",
      ruleName: existing.name,
      targetEntity: entity.name,
      confidence,
      explanation,
      diffSummary: summary,
      requiresCodeChange: true,
    };
  }

  // Declarative rule — same strict structural validation as add_rule. The
  // name is pinned to the EXISTING rule's name before validation so an
  // AI-side rename (out of scope) can never slip through as a new rule, and
  // `priority` / unchanged effect fields are back-filled from the existing
  // snapshot so an AI omission never silently resets them.
  const built = buildRuleDefinition(
    parsed.rule ? backfillUpdateShape(parsed.rule, existing) : undefined,
    entity,
  );
  if (!built.ok) {
    return noMatch("invalid_rule", SCHEMA_INTENT_MESSAGES.invalidRule(built.reason));
  }
  // Re-pin AFTER the build: `normalizeRuleName` runs inside the builder, so a
  // registered name that normalization would alter could otherwise make the
  // built name diverge from the pinned target. The governed change must name
  // the EXISTING rule, always.
  const ruleDef: RuleDefinition = { ...built.rule, name: existing.name };
  const summary = diffSummary || explanation;
  const proposal = engine.createProposal({
    type: "update_rule",
    description: explanation,
    reasoning: utterance,
    confidence,
    diff: {
      target: "rule",
      operation: "update",
      definition: ruleDef,
      targetName: existing.name,
      summary,
    },
  });
  return {
    kind: "proposal_draft",
    proposal,
    operation: "update",
    ruleName: ruleDef.name,
    targetEntity: entity.name,
    confidence,
    explanation,
    diffSummary: summary,
  };
}

/**
 * Merge the AI-returned update shape with the EXISTING rule snapshot so
 * fields the AI did not change survive verbatim (review-integrity — the
 * persisted definition must match the human-readable diff):
 *
 *  - `name` is pinned to the existing rule's name (renames out of scope).
 *  - `priority` falls back to the existing value when the AI omits it.
 *  - `trigger` falls back to the existing rule's trigger actions when the AI
 *    omits it (LLMs frequently leave out fields they treat as "unchanged",
 *    and `buildTrigger(undefined)` would otherwise fail the whole update).
 *  - Effect payload: when the AI omits the effect entirely the existing
 *    payload is used verbatim; when the AI keeps the SAME effect type (or
 *    omits `type` — a partial update payload), payload fields it omitted
 *    (message / level / setFields) are back-filled from the snapshot, and
 *    `setFields` merges ONE level deep so a partial setFields (only the
 *    changed keys) never silently drops the snapshot's other entries. A
 *    deliberate effect-type change is passed through unmerged (the builder
 *    validates its required fields).
 */
function backfillUpdateShape(rule: ParsedRuleShape, existing: SchemaIntentRule): ParsedRuleShape {
  const out: ParsedRuleShape = { ...rule, name: existing.name };
  if (out.priority === undefined && existing.priority !== undefined) {
    out.priority = existing.priority;
  }
  if (
    out.trigger === undefined &&
    Array.isArray(existing.triggerActions) &&
    existing.triggerActions.length > 0
  ) {
    out.trigger = {
      action:
        existing.triggerActions.length === 1 ? existing.triggerActions[0] : existing.triggerActions,
    };
  }
  const existingEffect = existing.effect;
  if (existingEffect) {
    if (out.effect === undefined) {
      out.effect = { ...existingEffect };
    } else if (typeof out.effect === "object" && out.effect !== null) {
      const aiEffect = out.effect as Record<string, unknown>;
      // Merge when the AI kept the same effect type OR omitted `type`
      // entirely (a partial payload). A type CHANGE skips the merge so
      // stale fields never leak into the new effect shape.
      if (aiEffect.type === undefined || aiEffect.type === existingEffect.type) {
        const merged: Record<string, unknown> = {
          ...existingEffect,
          ...aiEffect,
          // The merge only runs for same-or-omitted type, so the existing
          // type always wins (covers an explicit `type: undefined` too).
          type: existingEffect.type,
        };
        // `setFields` back-fills one level deep: a partial AI payload
        // carrying only the changed keys must not REPLACE the snapshot's
        // whole map (that would silently drop untouched entries).
        if (isPlainRecord(existingEffect.setFields) && isPlainRecord(aiEffect.setFields)) {
          merged.setFields = { ...existingEffect.setFields, ...aiEffect.setFields };
        }
        out.effect = merged;
      }
    }
  }
  return out;
}

/** Narrow to a plain object record (not null, not an array). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
