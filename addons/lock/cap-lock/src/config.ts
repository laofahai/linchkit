/**
 * cap-lock configuration schema (Spec 63 §4.2, Phase 3).
 *
 * Declares the three policy knobs the `field-lock-check` interceptor consumes:
 *  - `shadowMode`   — log violations but never block (rollout observation).
 *  - `bypassGroups` — actor groups/roles allowed to override locks.
 *  - `toleranceMs`  — grace window (ms) after a record's `created_at` during
 *                     which locked-field edits are permitted; `0` = disabled.
 *
 * Every knob has a SAFE default that preserves core enforcement byte-for-byte
 * (shadow off, no bypass groups, no tolerance) — installing cap-lock with an
 * empty config must NOT weaken the boundary.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

/**
 * Zod shape for the cap-lock config. Declared standalone so a precise policy
 * type can be inferred (the `defineConfigSchema` ref widens `.schema` to
 * `ZodObject<any>`, which erases the field types).
 */
const capLockConfigShape = {
  /**
   * When true, every lock violation is audit-logged and then SUPPRESSED
   * (the interceptor returns `[]`). For observing a lock rollout without
   * blocking writes. Default false — locks are enforced.
   */
  shadowMode: z
    .boolean()
    .default(false)
    .describe("Log lock violations but do not block (rollout observation mode)"),

  /**
   * Actor groups/roles that may override locks. An actor whose `groups`
   * intersect this list has its violations audit-logged then suppressed.
   * Default [] — no group can bypass.
   */
  bypassGroups: z
    .array(z.string())
    .default([])
    .describe("Actor groups/roles permitted to override field locks (e.g. admin, finance_manager)"),

  /**
   * Grace window in milliseconds after a record's `created_at` during which
   * locked fields remain editable. `0` (default) disables the tolerance
   * period entirely. Negative values are rejected by validation.
   */
  toleranceMs: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe(
      "Milliseconds after created_at during which locked fields stay editable (0 = disabled)",
    ),
} as const;

export const capLockConfig = defineConfigSchema("cap-lock", capLockConfigShape);

/**
 * Strict schema used to validate/normalize input into a fully-defaulted policy.
 * `.strict()` rejects unknown keys, matching `defineConfigSchema`'s behavior.
 */
const capLockPolicySchema = z.object(capLockConfigShape).strict();

/** Resolved, normalized cap-lock policy consumed by the interceptor handler. */
export type CapLockPolicy = z.infer<typeof capLockPolicySchema>;

/**
 * Normalize a partial config into a fully-defaulted {@link CapLockPolicy}.
 *
 * Parsing through the Zod schema applies defaults AND validates input
 * (rejecting e.g. a negative `toleranceMs` or a non-string in
 * `bypassGroups`), so a caller-supplied config can never silently produce an
 * unsafe policy. The strict schema also rejects unknown keys.
 */
export function resolveCapLockPolicy(config?: Partial<CapLockPolicy>): CapLockPolicy {
  return capLockPolicySchema.parse(config ?? {});
}
