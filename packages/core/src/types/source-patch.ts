/**
 * Source-patch seam types (#566, Option A — capability-seam).
 *
 * The say-to-code loop needs an approved change like "raise the manager-approval
 * threshold to 20000" to graduate into a real edit of a NAMED CONSTANT (e.g.
 * `export const MANAGER_APPROVAL_THRESHOLD = 10000;`) inside an EXISTING
 * capability source file — an in-place patch, not a brand-new generated file.
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
  /** Patched file content (equal to the input source when `changed` is false). */
  source: string;
  /** Previous value text (the literal that was replaced). */
  oldValueLiteral: string;
  /**
   * `false` ONLY when the constant was found but its value already equals the
   * target (an idempotent no-op). It MUST NOT be used to signal "constant not
   * found" — see the throw-on-absent contract on {@link SourcePatcher}. Callers
   * may safely skip rewriting the file when this is false.
   */
  changed: boolean;
}

/**
 * Injected source patcher — typescript-free from core's point of view.
 *
 * The implementation (a `patchNamedConstant` pure function backed by the TS AST)
 * lives in a NON-core package and is injected at the seam. Core only ever calls
 * this signature; it never knows how the patch is computed.
 *
 * Contract (so the caller never mistakes a silent failure for a no-op): the
 * patcher MUST THROW when the named constant cannot be located (or is ambiguous,
 * or has no initializer). A `changed: false` result is reserved EXCLUSIVELY for
 * "found, value already at target". The reference impl (`patchNamedConstant`)
 * throws NOT FOUND / AMBIGUOUS / NO INITIALIZER accordingly.
 */
export type SourcePatcher = (request: SourcePatchRequest) => SourcePatchResult;
