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
 *  4. Otherwise        — return violations UNCHANGED (block, fail-closed).
 */

import type { FieldLockCheckContext, FieldLockViolation, Logger } from "@linchkit/core";
import type { CapLockPolicy } from "./config";

/** Reason an audited suppression occurred — surfaced in the audit log. */
export type LockSuppressionReason = "shadow" | "bypass" | "tolerance";

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
  const { policy, logger } = options;
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

    const audit = (reason: LockSuppressionReason): void => {
      logger?.info(
        `cap-lock suppressed ${violations.length} field-lock violation(s) (${reason})`,
        buildAuditContext({ reason, context, violations }),
      );
    };

    // 1. Shadow mode — observe without blocking. Log every violation, allow.
    if (policy.shadowMode) {
      audit("shadow");
      return [];
    }

    // 2. Bypass groups — the actor's groups/roles override locks.
    //    The core `Actor.groups: string[]` field carries the actor's
    //    group/role memberships (set by the auth/permission slots — see
    //    cap-permission's `actor.groups` usage), which is exactly the concept
    //    the spec example references as `context.actor.groups`. Use it directly.
    if (
      policy.bypassGroups.length > 0 &&
      context.actor.groups.some((group) => policy.bypassGroups.includes(group))
    ) {
      audit("bypass");
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

    // 4. No policy matched — BLOCK. Return the violations UNCHANGED so core
    //    re-throws with the full per-field detail (fail-closed default).
    return violations;
  };
}
