/**
 * useFieldLockBypass / useFieldUnlock — whether the CURRENT actor may override
 * field locks, plus the per-field unlock state the auto-form needs (Spec 63 §5.2).
 *
 * `useFieldLockBypass` runs ONE GraphQL query (`{ fieldLockBypass { canBypass
 * reason } }`) per mount against the cap-lock read-side extension. The auto-form
 * uses the result to render an "unlock" affordance on locked fields.
 *
 * ## Resilience: cap-lock may not be installed
 *
 * When cap-lock is absent, `fieldLockBypass` is NOT a schema field and the
 * server returns a GraphQL VALIDATION error. `fetchCanBypass` swallows ALL
 * errors (and the missing-field case) and resolves to `false` — it never calls
 * `throwOnErrors`, never throws, and stays SILENT on the expected
 * "field not found" path (no console noise).
 *
 * ## No cross-session cache (deliberate)
 *
 * Each hook instance fetches once on mount and holds the result in component
 * state — there is NO module-level cache. So a logout / login or tenant switch
 * (which remounts the form) always re-evaluates for the current actor, and a
 * transient fetch failure never sticks as a permanent fail-closed decision (the
 * next mount retries). The query is cheap; correctness beats memoizing a
 * per-session boolean that goes stale on user switch and gets stuck on a
 * transient error.
 */

import { useCallback, useEffect, useState } from "react";
import { graphql } from "../lib/api";

interface FieldLockBypassQueryResult {
  fieldLockBypass?: { canBypass?: boolean; reason?: string | null } | null;
}

/**
 * Fetch the current actor's bypass eligibility via the `fieldLockBypass` query.
 *
 * `graphqlFn` is injectable PURELY so tests can supply a deterministic stub (the
 * package's test setup is logic-only — no DOM, no reliable global-fetch harness
 * under the batched runner); production always uses the real `graphql` helper.
 * Resolves to `false` on ANY unexpected condition (missing field, network
 * error, malformed response) so the UI fails closed (no unlock affordance).
 * Never throws.
 */
export async function fetchCanBypass(graphqlFn: typeof graphql = graphql): Promise<boolean> {
  try {
    const res = await graphqlFn<FieldLockBypassQueryResult>(
      "query { fieldLockBypass { canBypass reason } }",
    );
    // Intentionally do NOT call throwOnErrors: a missing `fieldLockBypass` field
    // (cap-lock not installed) surfaces as a GraphQL error we must swallow
    // quietly. Read the value defensively and default to false.
    return res.data?.fieldLockBypass?.canBypass === true;
  } catch {
    // Network / transport failure — fail closed.
    return false;
  }
}

/**
 * Returns `{ canBypass }` for the current actor. Starts `false` and flips to the
 * server's answer once the one-shot query resolves. Fetches once per mount (no
 * cross-session cache). Never throws.
 */
export function useFieldLockBypass(): { canBypass: boolean } {
  const [canBypass, setCanBypass] = useState(false);

  useEffect(() => {
    let active = true;
    fetchCanBypass().then((result) => {
      if (active) setCanBypass(result);
    });
    return () => {
      active = false;
    };
  }, []);

  return { canBypass };
}

/** Per-field unlock state consumed by the auto-form (Spec 63 §5.2). */
export interface FieldUnlockState {
  /** Whether the current actor may override field locks. */
  canBypass: boolean;
  /** Whether the actor has unlocked `field` for editing this session. */
  isUnlocked: (field: string) => boolean;
  /** Toggle a field's unlocked state (only meaningful when `canBypass`). */
  toggleUnlock: (field: string) => void;
}

/**
 * Bundle the actor's bypass eligibility with the set of fields they have
 * manually unlocked. Extracted from AutoForm so the bypass + lock/readonly
 * derivation lives in one tested hook rather than inline in that already-large
 * component.
 */
export function useFieldUnlock(): FieldUnlockState {
  const { canBypass } = useFieldLockBypass();
  const [unlockedFields, setUnlockedFields] = useState<Set<string>>(() => new Set());

  const toggleUnlock = useCallback((field: string) => {
    setUnlockedFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });
  }, []);

  const isUnlocked = useCallback((field: string) => unlockedFields.has(field), [unlockedFields]);

  return { canBypass, isUnlocked, toggleUnlock };
}
