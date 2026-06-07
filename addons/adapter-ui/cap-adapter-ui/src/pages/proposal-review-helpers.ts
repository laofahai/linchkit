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
