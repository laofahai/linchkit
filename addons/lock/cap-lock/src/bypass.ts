/**
 * Shared actor-level field-lock bypass predicate (Spec 63 §4.2 / §5.2).
 *
 * This is the SINGLE source of truth for "can THIS actor bypass field locks?",
 * consumed by BOTH:
 *  - the runtime `field-lock-check` interceptor (`./field-lock-interceptor`),
 *    which suppresses violations when the actor is bypass-eligible; and
 *  - the read-side `fieldLockBypass` GraphQL query (`./graphql`), which lets the
 *    UI render an "unlock" affordance for the same actor.
 *
 * Keeping both sides on one predicate guarantees the UI hint can NEVER drift
 * from the actual enforcement decision.
 *
 * ## Actor-level subset of the interceptor decision
 *
 * The interceptor's full decision has THREE escape hatches (see
 * {@link createFieldLockInterceptor}): shadow mode, bypass groups, and a
 * tolerance period. This function intentionally covers ONLY the first two —
 * the ACTOR-level subset:
 *
 *  - `shadowMode`   — global observe-without-blocking switch.
 *  - `bypassGroups` — actor group/role membership grants override.
 *
 * `toleranceMs` is DELIBERATELY EXCLUDED. Tolerance is a record-age / time-window
 * check (transient, evaluated per-record against that record's `created_at`),
 * NOT a stable capability of the actor. Surfacing it as an actor-level "can
 * bypass" signal would be misleading (it flips as records age), so it remains
 * interceptor-only and is evaluated there per write.
 *
 * The shadow → bypass evaluation order mirrors the interceptor exactly so the
 * two can never disagree on the actor-level subset.
 */

import type { Actor } from "@linchkit/core";
import type { CapLockPolicy } from "./config";

/** Why an actor is bypass-eligible — surfaced to the UI and the audit log. */
export type ActorBypassReason = "shadow" | "bypass";

/** Result of {@link evaluateActorBypass}. */
export interface ActorBypassResult {
  /** Whether the actor may bypass field locks under the current policy. */
  canBypass: boolean;
  /** Why the actor may bypass — `null` when `canBypass` is false. */
  reason: ActorBypassReason | null;
}

/**
 * Decide whether `actor` may bypass field locks under `policy` (actor-level
 * subset of the interceptor decision; see the module JSDoc).
 *
 * Evaluation order (first match wins), mirroring the interceptor:
 *  1. `policy.shadowMode` → `{ canBypass: true, reason: "shadow" }`.
 *  2. else if the actor belongs to ANY `policy.bypassGroups` entry →
 *     `{ canBypass: true, reason: "bypass" }`.
 *  3. otherwise → `{ canBypass: false, reason: null }`.
 *
 * Pure and side-effect-free. `toleranceMs` is NOT considered here (it is a
 * per-record time-window check, evaluated only in the interceptor).
 */
export function evaluateActorBypass(actor: Actor, policy: CapLockPolicy): ActorBypassResult {
  // 1. Shadow mode — global observe-without-blocking switch.
  if (policy.shadowMode) {
    return { canBypass: true, reason: "shadow" };
  }

  // 2. Bypass groups — the actor's group/role memberships override locks.
  if (
    policy.bypassGroups.length > 0 &&
    actor.groups?.some((group) => policy.bypassGroups.includes(group))
  ) {
    return { canBypass: true, reason: "bypass" };
  }

  // 3. No actor-level escape hatch matched.
  return { canBypass: false, reason: null };
}
