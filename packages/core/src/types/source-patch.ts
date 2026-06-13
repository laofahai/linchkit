/**
 * Source-patch seam types (#566, Option A — capability-seam).
 *
 * The 说→有 loop needs an approved change like "把经理审批阈值改成 2 万" to graduate
 * into a real edit of a NAMED CONSTANT (e.g. `export const MANAGER_APPROVAL_THRESHOLD = 10000;`)
 * inside an EXISTING capability source file — an in-place patch, not a brand-new
 * generated file.
 *
 * The actual TypeScript-AST patcher (`patchNamedConstant`) is a heavy dependency
 * (`import ... from "typescript"`) and MUST live OUTSIDE `@linchkit/core`. This
 * seam keeps core typescript-free: core declares only the request/result shapes
 * and the `SourcePatcher` function type, and the concrete patcher is INJECTED
 * (e.g. into `ProposalFileWriter`). Core never imports the patcher's
 * implementation.
 */

/** Request to an injected source patcher: replace a named const's value in file text. */
export interface SourcePatchRequest {
  /** Current file content (the existing source to patch). */
  source: string;
  /** Name of the exported constant to patch, e.g. "MANAGER_APPROVAL_THRESHOLD". */
  constantName: string;
  /** Already-serialized literal to write, e.g. "20000" or '"manager"'. */
  newValueLiteral: string;
}

/** Result returned by an injected source patcher. */
export interface SourcePatchResult {
  /** Patched file content. */
  source: string;
  /** Previous value text (the literal that was replaced). */
  oldValueLiteral: string;
  /** `false` iff the value was unchanged (no-op patch). */
  changed: boolean;
}

/**
 * Injected source patcher — typescript-free from core's point of view.
 *
 * The implementation (a `patchNamedConstant` pure function backed by the TS AST)
 * lives in a NON-core package and is injected at the seam. Core only ever calls
 * this signature; it never knows how the patch is computed.
 */
export type SourcePatcher = (request: SourcePatchRequest) => SourcePatchResult;
