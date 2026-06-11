/**
 * Pure helpers for the Proposal Review page (`proposal-review.tsx`).
 *
 * Extracted so the status→badge mapping and action-availability predicates can
 * be unit-tested without rendering React. NO side effects, NO imports from the
 * server/core runtime (module-boundary rule).
 */

/** Status filter options surfaced in the review page dropdown. */
export const PROPOSAL_STATUS_FILTERS = [
  "all",
  "draft",
  "validating",
  "validated",
  "approved",
  "rejected",
  "committed",
] as const;

export type ProposalStatusFilter = (typeof PROPOSAL_STATUS_FILTERS)[number];

/**
 * Statuses that are still "pending" review — eligible for Approve / Reject.
 * A proposal in any of these states has not yet been decided.
 */
const PENDING_STATUSES = new Set(["draft", "validating", "validated"]);

/** True when a proposal can be approved / rejected (still under review). */
export function isPending(status: string): boolean {
  return PENDING_STATUSES.has(status);
}

/**
 * True when a proposal can be graduated (write files + open a PR). Only an
 * `approved` proposal is eligible — the server enforces this too (422 otherwise),
 * this predicate just gates the button so the user is not offered a no-op.
 */
export function canGraduate(status: string): boolean {
  return status === "approved";
}

/** Tailwind classes for a status Badge, keyed by proposal status. */
export function statusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    draft: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
    validating: "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300",
    validated: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
    approved: "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300",
    rejected: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300",
    committed: "bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300",
  };
  return map[status] ?? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300";
}

/** Tailwind classes for the changeType badge (patch / minor / major). */
export function changeTypeBadgeClass(changeType: string): string {
  const map: Record<string, string> = {
    patch: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
    minor: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
    major: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300",
  };
  return map[changeType] ?? "";
}

/**
 * Changes that carry candidate source (materialized successfully). Mirrors the
 * inline filter the review page used to do, lifted out so it is unit-testable.
 * Generic + structural so it never imports the page's wire type.
 */
export function selectSourcedChanges<T extends { generatedSource?: string }>(
  changes: readonly T[],
): T[] {
  return changes.filter(
    (c) => typeof c.generatedSource === "string" && c.generatedSource.trim().length > 0,
  );
}

/**
 * Changes whose materialization FAILED the build gate. This is the durable
 * signal: such a change has no `generatedSource` but carries
 * `materializationStatus:"failed"` plus the reason in `materializationErrors`.
 * Surfacing these tells the reviewer WHICH changes failed code generation and WHY.
 */
export function selectFailedMaterializationChanges<
  T extends { materializationStatus?: string; materializationErrors?: string[] },
>(changes: readonly T[]): T[] {
  return changes.filter((c) => c.materializationStatus === "failed");
}

/**
 * Changes that have a recorded dry-run result worth surfacing to the reviewer
 * (Spec 70 P4). Returns changes whose `dryRunStatus` is present and is NOT
 * `"skipped"` — i.e. the sandbox actually ran (or tried) and produced a signal.
 * "skipped" means no runner was configured or the change was not materializable —
 * nothing for the reviewer to act on.
 */
export function selectDryRunChanges<T extends { dryRunStatus?: string }>(
  changes: readonly T[],
): T[] {
  return changes.filter((c) => typeof c.dryRunStatus === "string" && c.dryRunStatus !== "skipped");
}

/**
 * Shape the materialize-request scope for a single change-name retry. Returns the
 * `{ changeNames }` option object that scopes `materializeProposal` to JUST this
 * change, so re-generating one failed change never regenerates the good ones.
 * Pure so the request shaping is unit-testable without the React render.
 */
export function buildMaterializeScope(changeName: string): { changeNames: string[] } {
  return { changeNames: [changeName] };
}

/** Narrow a caught unknown to its message, falling back to a default string. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
