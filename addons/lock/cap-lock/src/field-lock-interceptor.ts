/**
 * cap-lock `field-lock-check` interceptor (Spec 63 §4.2, Phase 3 PR-2).
 *
 * This is the capability layer on top of core's Phase 1 field-lock enforcement.
 * Core's Action Engine threads the computed `FieldLockViolation[]` through the
 * `field-lock-check` interceptor point BEFORE throwing; this handler decides
 * whether to suppress those violations under one of three policy escape hatches.
 *
 * ## Contract with the core interceptor registry
 *
 * The handler TRANSFORMS the violation set by RETURNING a value, never by
 * mutating its argument (core hands us a defensive deep clone, but we still
 * return a fresh/unmutated array). Per the catalog typing:
 *  - return `[]`                     → ALLOW all (suppress every violation).
 *  - return the violations UNCHANGED → BLOCK (fail-closed; core re-throws).
 *
 * It must NEVER weaken core enforcement beyond the explicit, audited policy
 * below — every suppression path requires an active config knob AND is
 * audit-logged. The default (no knob matches) returns the violations exactly
 * as received, so cap-lock with empty config is a no-op over core.
 *
 * ## Evaluation order (first match wins, returns `[]`)
 *  1. Shadow mode      — `shadowMode: true`.
 *  2. Bypass groups    — actor belongs to ANY `bypassGroups` entry.
 *  3. Tolerance period — `toleranceMs > 0` AND record age < toleranceMs.
 *  4. Soft locks       — `violation.mode === "soft"`: advisory, the soft
 *                        violations are audited and dropped; any hard violations
 *                        still block (return the hard subset). NOT actor-gated —
 *                        the UI two-step confirmation is the deliberateness gate.
 *  5. Otherwise        — block (fail-closed): return the (hard) violations
 *                        UNCHANGED so core re-throws.
 */

import type { FieldLockCheckContext, FieldLockViolation, Logger } from "@linchkit/core";
import { evaluateActorBypass } from "./bypass";
import type { CapLockPolicy } from "./config";
import { buildLockOverrideEvent, type LockOverrideEvent } from "./events";

/** Reason an audited suppression occurred — surfaced in the audit log. */
export type LockSuppressionReason = "shadow" | "bypass" | "tolerance" | "soft";

/** Options for {@link createFieldLockInterceptor}. */
export interface FieldLockInterceptorOptions {
  /** Resolved, fully-defaulted policy (see {@link resolveCapLockPolicy}). */
  policy: CapLockPolicy;
  /**
   * Structured logger for the audit trail (Spec 63 §4.2 "Audit trail — Log all
   * lock violations and forced modifications"). When omitted, suppressions are
   * silent — but the policy decision is unchanged.
   */
  logger?: Logger;
  /**
   * Injectable wall-clock source (epoch ms) for deterministic tolerance tests.
   * Defaults to {@link Date.now}. Using `Date.now` in real capability code is
   * fine; the seam exists purely so tests can pin "now".
   */
  now?: () => number;
  /**
   * Fire-and-forget sink for "locked field force-modified" events (Spec 63 §4.2
   * Notification). Called once per suppression, 1:1 with the audit log. Injected
   * exactly like `logger`; when omitted, no event is emitted. The host maps the
   * event to a notification / execution-log entry, keeping cap-lock free of any
   * notification or event-bus dependency.
   *
   * May be sync or async (notification dispatch / event-bus publish typically
   * returns a `Promise`). Both a synchronous throw AND an async rejection are
   * isolated by the interceptor so a faulty sink can never break the write path.
   */
  emitEvent?: (event: LockOverrideEvent) => void | Promise<void>;
}

/**
 * Coerce a `created_at` value to an epoch-millisecond timestamp.
 *
 * Robustly accepts:
 *  - a `Date`          → `getTime()` (rejected if the Date is Invalid → NaN).
 *  - an ISO/parseable string → `Date.parse`, accepted only when finite.
 *  - a finite epoch number   → returned as-is (already milliseconds).
 *
 * Returns `null` for anything missing, non-finite, or unparseable. The caller
 * treats `null` as "cannot apply tolerance" and FAILS CLOSED (does not
 * suppress), so a missing/garbage timestamp can never open the grace window.
 */
function parseCreatedAt(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Build the structured audit context emitted when violations are suppressed.
 * Includes the required fields from Spec 63 §4.2: capability, reason, entity,
 * actor id, and the suppressed field names.
 */
function buildAuditContext(opts: {
  reason: LockSuppressionReason;
  context: FieldLockCheckContext;
  violations: readonly FieldLockViolation[];
}): Record<string, unknown> {
  return {
    capability: "lock",
    reason: opts.reason,
    entity: opts.context.entity,
    actorId: opts.context.actor.id,
    actorType: opts.context.actor.type,
    tenantId: opts.context.tenantId,
    fields: opts.violations.map((v) => v.field),
    violationCount: opts.violations.length,
  };
}

/**
 * Create the cap-lock `field-lock-check` interceptor handler.
 *
 * @returns an async handler matching `InterceptorCatalog["field-lock-check"]`.
 */
export function createFieldLockInterceptor(
  options: FieldLockInterceptorOptions,
): (
  violations: FieldLockViolation[],
  context: FieldLockCheckContext,
) => Promise<FieldLockViolation[]> {
  const { policy, logger, emitEvent } = options;
  const now = options.now ?? Date.now;

  return async (
    violations: FieldLockViolation[],
    context: FieldLockCheckContext,
  ): Promise<FieldLockViolation[]> => {
    // Nothing to decide: no violations means core would have allowed the write.
    // Return the (empty) set unchanged — never log a no-op as a suppression.
    if (violations.length === 0) {
      return violations;
    }

    const audit = (
      reason: LockSuppressionReason,
      audited: readonly FieldLockViolation[] = violations,
    ): void => {
      logger?.info(
        `cap-lock suppressed ${audited.length} field-lock violation(s) (${reason})`,
        buildAuditContext({ reason, context, violations: audited }),
      );
      // Spec 63 §4.2 Notification: emit a structured override event 1:1 with the
      // audit log. The host wires the sink (EventHandler / execution log); cap-lock
      // stays dependency-free. A faulty sink must never turn an allowed write into
      // a throw, so the emit is fully isolated — for BOTH a synchronous throw and
      // an async rejection (the sink is likely a Promise-returning dispatch).
      if (emitEvent) {
        try {
          const result = emitEvent(
            buildLockOverrideEvent({ reason, context, violations: audited }),
          );
          if (result instanceof Promise) {
            // Swallow async rejection so it never becomes an unhandled rejection.
            result.catch((err: unknown) => {
              logger?.warn("cap-lock emitEvent sink rejected; event dropped", {
                error: String(err),
              });
            });
          }
        } catch (err) {
          logger?.warn("cap-lock emitEvent sink threw; event dropped", { error: String(err) });
        }
      }
    };

    // 1 & 2. Actor-level escape hatches — shadow mode, then bypass groups.
    //    Delegated to the SHARED `evaluateActorBypass` predicate so the runtime
    //    enforcement decision can never drift from the read-side
    //    `fieldLockBypass` GraphQL hint (which calls the same function). The
    //    returned `reason` ("shadow" | "bypass") flows straight into the audit
    //    log. The core `Actor.groups: string[]` field carries the actor's
    //    group/role memberships (set by the auth/permission slots — see
    //    cap-permission's `actor.groups` usage), which the predicate inspects.
    const actorBypass = evaluateActorBypass(context.actor, policy);
    if (actorBypass.canBypass && actorBypass.reason !== null) {
      audit(actorBypass.reason);
      return [];
    }

    // 3. Tolerance period — fresh records may be freely edited for a window.
    //    Disabled when toleranceMs <= 0. Fails CLOSED on a missing/unparseable
    //    created_at (parseCreatedAt → null) so an absent timestamp never opens
    //    the window.
    if (policy.toleranceMs > 0) {
      const createdAt = parseCreatedAt(context.record.created_at);
      if (createdAt !== null) {
        const age = now() - createdAt;
        // age < 0 (clock skew / future created_at) still falls inside the
        // window — a record that claims to be from the future is trivially
        // "younger" than the tolerance, so it is treated as within grace.
        if (age < policy.toleranceMs) {
          audit("tolerance");
          return [];
        }
      }
    }

    // 4. Soft locks (Spec 63 §4.2 SOFT_LOCK). A soft violation is ADVISORY:
    //    cap-lock allows the write but records an audit entry. The deliberateness
    //    gate is the UI's two-step confirmation, NOT an actor capability, so this
    //    branch is deliberately NOT routed through `evaluateActorBypass` — any
    //    actor may proceed past a soft lock. Hard violations in the same set still
    //    block, so we partition and return only the hard subset.
    const soft = violations.filter((v) => v.mode === "soft");
    // No soft locks: this is the fail-closed default — return the violations
    // UNCHANGED (same reference) so cap-lock with no matching knob is a pure
    // no-op over core, which re-throws with the full per-field detail.
    if (soft.length === 0) {
      return violations;
    }

    audit("soft", soft);

    // 5. Soft violations are dropped (advisory allow); any HARD violations in
    //    the same set still block. Returns `[]` for the soft-only allow.
    return violations.filter((v) => v.mode !== "soft");
  };
}
