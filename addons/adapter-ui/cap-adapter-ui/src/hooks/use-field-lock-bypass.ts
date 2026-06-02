/**
 * useFieldLockBypass — whether the CURRENT actor may override field locks
 * (Spec 63 §5.2).
 *
 * Runs ONE GraphQL query (`{ fieldLockBypass { canBypass reason } }`) against
 * the cap-lock read-side extension. The auto-form uses the result to render an
 * "unlock" affordance on locked fields for bypass-eligible actors.
 *
 * ## Resilience: cap-lock may not be installed
 *
 * When cap-lock is absent, `fieldLockBypass` is NOT a schema field and the
 * server returns a GraphQL VALIDATION error. The hook swallows ALL errors (and
 * the missing-field case) and returns `{ canBypass: false }` — it never calls
 * `throwOnErrors`, never throws, and stays SILENT on the expected
 * "field not found" path (no console noise).
 *
 * The result is cached at module level (session-scoped) so multiple forms on a
 * page share a single in-flight/resolved fetch; a full page reload resets it.
 */

import { useEffect, useState } from "react";
import { graphql } from "../lib/api";

interface FieldLockBypassQueryResult {
  fieldLockBypass?: { canBypass?: boolean; reason?: string | null } | null;
}

/**
 * Module-level cache of the resolved (or in-flight) bypass eligibility. Shared
 * across every form on the page; reset only by a page reload. Resolves to
 * `false` on ANY unexpected condition (missing field, network error, malformed
 * response) so the UI fails closed (no unlock affordance).
 */
let cachedPromise: Promise<boolean> | null = null;

/**
 * Fetch (and module-cache) the actor's bypass eligibility. Exported for
 * testing: the package's test setup is logic-only (no React render harness), so
 * the fetch / error-swallow behavior is verified directly against this helper —
 * mirroring how sibling component modules export their pure logic.
 */
export function fetchCanBypass(): Promise<boolean> {
  if (cachedPromise) return cachedPromise;
  cachedPromise = (async () => {
    try {
      const res = await graphql<FieldLockBypassQueryResult>(
        "query { fieldLockBypass { canBypass reason } }",
      );
      // Intentionally do NOT call throwOnErrors: a missing `fieldLockBypass`
      // field (cap-lock not installed) surfaces as a GraphQL error we must
      // swallow quietly. Read the value defensively and default to false.
      return res.data?.fieldLockBypass?.canBypass === true;
    } catch {
      // Network / transport failure — fail closed.
      return false;
    }
  })();
  return cachedPromise;
}

/**
 * Reset the module-level cache. Test-only seam so each case starts fresh; not
 * used by production code (the cache is intentionally session-scoped there).
 */
export function resetFieldLockBypassCache(): void {
  cachedPromise = null;
}

/**
 * Returns `{ canBypass }` for the current actor. Starts `false` and flips to
 * the server's answer once the one-shot query resolves. Never throws.
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
