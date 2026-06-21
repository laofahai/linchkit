/**
 * Credit-policy enforcement rule — hand-seeded "经验→制度" governance on the
 * partner demo (Build B, PR2).
 *
 * Goal: prove that a `defineRule` with effect `require_approval` ACTUALLY
 * suspends a credit-changing CRUD action at execution time. This is the first
 * piece of enforcement on the partner extension demo (#619/#620 shipped the
 * `partner` entity + the cap-sales `credit_limit` extension but ZERO actions and
 * ZERO rules) — it de-risks the core wiring before any AI loop is layered on.
 *
 * Policy encoded here, in ONE first-class object: when a partner flagged as a
 * late payer (`is_late_payer === true`, added by cap-sales) has its
 * `credit_limit` RAISED, that change must go through approval. Lowering the
 * limit, or raising it for a partner in good standing, proceeds normally.
 *
 * ── Trigger decision (action vs fieldChange) ────────────────────────────────
 * This rule uses an ACTION trigger `{ action: "update_partner" }`, NOT a
 * `FieldChangeTrigger`. Evidence: the action-execution rule path collects rules
 * via `collectRules` (packages/core/src/engine/rule-engine.ts:133-151), which
 * matches ONLY `trigger.action` — its own doc comment (lines 127-128) states
 * "Non-action triggers (state-change, field-change, event, schedule) are
 * filtered out; they don't apply to the action-execution path." A
 * `FieldChangeTrigger` would therefore never fire on a CRUD update, so the
 * credit-delta check is done in the code condition instead.
 *
 * `update_partner` is the CRUD action auto-generated for the `partner` entity
 * (addons/.../graphql/build-crud-actions.ts:161 `name: update_${name}`); its
 * input includes `credit_limit` (a non-system field) so a raise flows through
 * it.
 *
 * Enforcement happens via the real rule-in-action wiring (core
 * `evaluateActionRules`): when this rule yields `require_approval` AND an
 * ApprovalEngine is wired, the action is suspended into a pending approval
 * request instead of committing the write.
 */

import type { CodeCondition, RuleDefinition } from "@linchkit/core";

/**
 * Coerce a value to a finite number, accepting BOTH native numbers and numeric
 * strings. This matters on two sides of the same comparison:
 *  - the proposed value: a caller can submit `credit_limit: "5000"` (a string).
 *    Under lenient action validation that string is written as-is, so the gate
 *    MUST treat it as the number 5000 — otherwise a string-encoded raise slips
 *    past approval entirely (a real bypass).
 *  - the stored baseline: Drizzle `numeric()` columns round-trip as strings, so
 *    a persisted `credit_limit` of `"1000"` must compare as 1000, not be
 *    mistaken for an absent/zero baseline (which would wrongly gate a decrease).
 * Returns null for anything that is not a finite numeric value (undefined, null,
 * "", whitespace, "abc", booleans, objects).
 */
const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Actor-independent gate: require approval ONLY when the partner is flagged as a
 * late payer AND the requested `credit_limit` is strictly greater than the
 * stored one (an increase). Decreases and equal/no-op writes pass through, and a
 * partner in good standing is never gated.
 *
 * SECURITY / anti-spoof: the CURRENT limit and the late-payer flag are read from
 * `record` (the persisted row, threaded through untouched by caller input) —
 * NOT from `target`, which merges the caller's input over the stored values.
 * Reading the stored `credit_limit` from `target` would let a caller defeat the
 * "is this an increase?" check by also lying about the baseline; reading the
 * flag from `target` would let a late payer self-clear `is_late_payer` in the
 * same write to dodge the gate. The PROPOSED new limit is, correctly, taken from
 * `target` (it is what the caller wants to write).
 *
 * Fail-CLOSED on a missing stored row: with no record we cannot prove the change
 * is a decrease or that the partner is in good standing, so we do not gate a
 * phantom id here — the action engine's own absent-row handling and the write
 * path reject such calls. We return `false` (no approval) only when we can
 * affirmatively show the change is NOT a gated raise.
 */
const raisingCreditForLatePayer: CodeCondition = ({ target, record }) => {
  // No stored row → not an update of an existing partner. Nothing to gate here;
  // the write path handles absent/phantom ids. (A create cannot carry a prior
  // credit_limit to "raise" from, so there is no increase to constrain.)
  if (record == null) return false;

  // The flag must come from the STORED record so a caller cannot self-clear it
  // in the same mutation. A non-`true` value (false / absent / unknown) means
  // the partner is not flagged → never gated.
  if (record.is_late_payer !== true) return false;

  // Proposed new limit: what the caller wants to write. Coerced through
  // `toFiniteNumber` so a string-encoded raise (`"5000"`) is compared as a
  // number, not waved through.
  const proposed = toFiniteNumber(target.credit_limit);
  if (proposed === null) {
    // The proposed value is present-but-not-a-finite-number (Infinity,
    // "1e309", "abc", …). We cannot prove it is a safe change, so FAIL CLOSED —
    // route it through approval rather than letting an unreasonable value slip
    // past the gate. Exception: if it is unchanged from the stored value it is
    // not a credit change at all, so there is nothing to gate.
    //
    // Both nullish (absent input / NULL column) → no change → not gated. The
    // loose `== null` guard avoids `undefined !== null` wrongly gating a
    // non-change when a nullable column reads back as null.
    if (target.credit_limit == null && record.credit_limit == null) return false;
    return target.credit_limit !== record.credit_limit;
  }

  // Current limit: read from the stored row only, and coerced the same way
  // (Drizzle `numeric()` returns strings). Treat an absent/non-numeric stored
  // limit as 0 so the FIRST time a limit is set on a late payer (from "no
  // limit" to a positive value) still counts as a raise that must be approved —
  // otherwise the gate could be sidestepped by leaving the seed limit unset.
  const current = toFiniteNumber(record.credit_limit) ?? 0;

  // Gate ONLY a strict increase. Decreases and no-ops proceed normally.
  //
  // Known limitation: the comparison uses JS numbers, so two limits that differ
  // only beyond Number.MAX_SAFE_INTEGER (~9e15) are indistinguishable. Real
  // credit limits never approach this; BigInt-precise comparison would be
  // over-engineering for this policy.
  return proposed > current;
};

/**
 * Late-payer credit-raise approval rule.
 *
 * trigger:   the partner update action (CRUD `update_partner`).
 * condition: stored `is_late_payer === true` AND proposed `credit_limit` >
 *            stored `credit_limit` (code condition — see above).
 * effect:    require_approval at the `manager` level.
 */
export const latePayerCreditRaiseRule: RuleDefinition = {
  name: "late_payer_credit_raise_requires_approval",
  label: "Late-Payer Credit Raise Requires Approval",
  description:
    "Raising the credit limit of a partner flagged as a late payer requires " +
    "approval. Lowering the limit, or any change for a partner in good standing, " +
    "proceeds without approval.",
  // Fires during the partner update action's rule-evaluation step. A
  // FieldChangeTrigger would NOT fire here (collectRules drops non-action
  // triggers) — see the file header for the file:line evidence.
  trigger: { action: "update_partner" },
  condition: raisingCreditForLatePayer,
  effect: {
    type: "require_approval",
    level: "manager",
    message:
      "迟付款客户提升信用额度需要审批 / " +
      "Raising the credit limit of a late-paying partner requires approval",
  },
};
