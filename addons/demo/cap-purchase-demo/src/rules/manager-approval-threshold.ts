/**
 * Manager-approval-threshold business rule (the procurement scenario's core).
 *
 * This is the single, first-class object that encodes the procurement policy
 * "large purchases need a manager". A future "说→有" NL loop edits THIS rule
 * (and the {@link MANAGER_APPROVAL_THRESHOLD} constant it owns) to change the
 * policy — no action / flow code has to change.
 *
 * Enforcement: the rule fires inside `approve_purchase_request` execution via
 * the real rule-in-action wiring (core `evaluateActionRules`, PRs #460-#475).
 * It is NOT a hand-rolled check inside the approve action — the action stays a
 * pure declarative state transition; the AUTHORITY lives in this rule.
 *
 * Semantics:
 *   - amount <= MANAGER_APPROVAL_THRESHOLD → anyone who may run the approve
 *     action passes (rule does not trigger).
 *   - amount  > MANAGER_APPROVAL_THRESHOLD → ONLY a manager-class actor may
 *     approve; everyone else is BLOCKED with a bilingual message.
 *
 * The rule reads the record `amount` (the record is merged under the input by
 * the engine, so a stored amount is visible even when the approve input only
 * carries an `id`) and the acting user's role via `actor.groups`.
 */

import type { CodeCondition, RuleDefinition } from "@linchkit/core";

/**
 * Single source of truth for the manager-approval amount threshold.
 *
 * Both the authority rule below AND the auto-approval routing flow
 * (`purchase-approval.ts`) reference this constant, so the threshold is encoded
 * exactly once. Change it here and both the rule and the flow follow.
 */
export const MANAGER_APPROVAL_THRESHOLD = 10000;

/**
 * Actor groups that count as "a manager" for the approval-authority check.
 *
 * The capability declares `purchase_manager` / `purchase_user` permission
 * groups (see `capability.ts`). When cap-permission is active those map onto
 * `actor.groups`. In the demo's no-auth dev mode the elevated actor instead
 * carries the generic `manager` / `admin` groups, so we accept those too — the
 * rule's manager check stays meaningful under whichever role mechanism is live.
 */
const MANAGER_GROUPS = ["purchase_manager", "manager", "admin"] as const;

/** True when the actor belongs to at least one manager-class group. */
function actorIsManager(groups: string[] = []): boolean {
  // Defensive default: a nullish `groups` from an unexpected actor payload
  // must not crash the condition (a throw would fail-closed and block ALL
  // approvals, valid ones included).
  return (groups ?? []).some((g) => (MANAGER_GROUPS as readonly string[]).includes(g));
}

/**
 * Trigger only when the request exceeds the threshold AND the actor is not a
 * manager. When triggered, the `block` effect aborts the approval before any
 * write. A code condition (not a declarative one) keeps the two-part check —
 * amount AND role — in one readable, type-safe place.
 *
 * SECURITY: the amount is read from `record` (the persisted row, threaded
 * through untouched by caller input) — NEVER from `target`, which merges the
 * caller's input over the stored values. Reading `target.amount` would let any
 * caller bypass the gate by spoofing `{ id, amount: 1 }` while the state
 * transition still approves the stored high-value request (codex P1 on the
 * scenario-P1 review). `target` is only the fallback when no stored row exists
 * (which cannot satisfy approve's pending→approved transition anyway).
 */
const overThresholdNonManager: CodeCondition = ({ target, actor, record }) => {
  // `!= null` covers a runtime null as well as undefined. Deliberately NOT
  // `record?.amount ?? target.amount`: when a stored row EXISTS, its amount is
  // authoritative even if nullish — falling back to caller-controlled `target`
  // there would reopen the input-spoof bypass this rule exists to close.
  const raw = record != null ? record.amount : target.amount;
  const amount = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(amount)) return false;
  if (amount <= MANAGER_APPROVAL_THRESHOLD) return false;
  return !actorIsManager(actor.groups);
};

export const managerApprovalThresholdRule: RuleDefinition = {
  name: "manager_approval_threshold",
  label: "Manager Approval Threshold",
  description:
    `Purchase requests over ${MANAGER_APPROVAL_THRESHOLD} may only be approved ` +
    "by a manager. Smaller requests can be approved by any purchase user.",
  // Fires during the approve action's rule-evaluation step.
  trigger: { action: "approve_purchase_request" },
  condition: overThresholdNonManager,
  effect: {
    type: "block",
    // No separate `reason`: the engine surfaces `reason ?? message` as the block
    // reason, and the bilingual message IS the user-facing point of this rule,
    // so it must be what reaches the caller / execution log.
    message:
      `金额超过 ${MANAGER_APPROVAL_THRESHOLD} 需要经理审批 / ` +
      `Amounts over ${MANAGER_APPROVAL_THRESHOLD} require manager approval`,
  },
};
