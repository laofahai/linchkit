/**
 * Capability ↔ core version-compatibility check (Spec 21).
 *
 * Each capability MAY declare a `coreVersion` semver RANGE describing which
 * @linchkit/core versions it is compatible with. At boot, the active set is
 * checked against the running core `VERSION`. Mismatches are surfaced either
 * as hard errors (strict mode) or warnings (non-strict, the current default).
 */

import { LinchKitError } from "../errors";
import type { Logger } from "../types/logger";
import { satisfiesVersionRange } from "./capability-hub";

// ── Types ────────────────────────────────────────────────

/** A single capability ↔ core version-compatibility finding. */
export interface CompatIssue {
  /** Capability name that declared the incompatible range. */
  capability: string;
  /** The declared core-version range (semver). */
  required: string;
  /** The actual running core version. */
  actual: string;
  /** Human-readable explanation. */
  detail: string;
}

/** Minimal shape a capability must expose for the compatibility check. */
export interface CompatCapability {
  name: string;
  /** Optional semver RANGE of compatible core versions. */
  coreVersion?: string;
}

/** Result of {@link checkCoreCompatibility}. */
export interface CoreCompatibilityResult {
  errors: CompatIssue[];
  warnings: CompatIssue[];
}

/** The `linchkit` compatibility block of a capability's metadata. */
export interface MetadataCompatibility {
  /** Semver RANGE of compatible core versions (preferred, used verbatim). */
  coreVersion?: string;
  /**
   * @deprecated Minimum compatible core version (a bare version, not a range).
   * Used only when `coreVersion` is absent; normalized to a `>=` range so that
   * {@link satisfiesVersionRange} treats it as a minimum rather than an exact
   * match.
   */
  minVersion?: string;
}

// ── coreVersion range resolution ─────────────────────────

/** Comparator operators that mark a string as already being a semver range. */
const COMPARATOR_OPERATORS = ["<", ">", "=", "~", "^"] as const;

/**
 * Normalize a deprecated `minVersion` into an effective semver range.
 *
 * `minVersion` is a MINIMUM version (e.g. "0.1.0"), but {@link satisfiesVersionRange}
 * treats a bare version as an EXACT match. To preserve the "minimum" semantics
 * we prefix it with `>=`. If the value already starts with a comparator operator
 * (`<`, `>`, `=`, `~`, `^`) it is assumed to already be a range and returned as-is.
 */
export function normalizeMinVersion(minVersion: string): string {
  const trimmed = minVersion.trim();
  const startsWithComparator = COMPARATOR_OPERATORS.some((op) => trimmed.startsWith(op));
  return startsWithComparator ? trimmed : `>=${trimmed}`;
}

/**
 * Resolve the effective core-version range a capability should be checked
 * against, from its `linchkit` metadata block.
 *
 * - Prefers `coreVersion` (already a semver range) verbatim.
 * - Falls back to the deprecated `minVersion`, normalized to a `>=` range via
 *   {@link normalizeMinVersion} so a bare version is treated as a minimum.
 * - Returns `undefined` when neither is declared.
 */
export function coreVersionRangeOf(
  linchkit: MetadataCompatibility | undefined,
): string | undefined {
  if (linchkit?.coreVersion) return linchkit.coreVersion;
  if (linchkit?.minVersion) return normalizeMinVersion(linchkit.minVersion);
  return undefined;
}

/** Options for {@link enforceCoreCompatibility}. */
export interface EnforceCoreCompatibilityOptions {
  /**
   * When true, an incompatibility throws a {@link LinchKitError}. When false
   * (the default boot behavior — see dev.ts), incompatibilities are logged as
   * warnings and boot continues.
   */
  strict: boolean;
  /** Logger used to emit warnings in non-strict mode. Defaults to console. */
  logger?: Logger;
}

// ── Default logger ───────────────────────────────────────

/**
 * Console-backed fallback logger. Kept browser-safe so this module can live in
 * the client barrel; callers that have a structured logger (e.g. the CLI's
 * `consoleLogger`) should inject it via options.
 */
const defaultLogger: Logger = {
  debug: (message: string, ...args: unknown[]) => console.debug(message, ...args),
  info: (message: string, ...args: unknown[]) => console.info(message, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
};

// ── Check ────────────────────────────────────────────────

/**
 * Check each capability's declared `coreVersion` range against the running
 * core version. Capabilities without a `coreVersion` are skipped. Currently
 * every mismatch is reported as a warning; callers decide (via strict mode in
 * {@link enforceCoreCompatibility}) whether to escalate to an error.
 */
export function checkCoreCompatibility(
  caps: CompatCapability[],
  coreVersion: string,
): CoreCompatibilityResult {
  const warnings: CompatIssue[] = [];

  for (const cap of caps) {
    if (!cap.coreVersion) continue; // No declared range — skip.
    if (satisfiesVersionRange(coreVersion, cap.coreVersion)) continue; // Compatible.

    warnings.push({
      capability: cap.name,
      required: cap.coreVersion,
      actual: coreVersion,
      detail: `Capability "${cap.name}" requires @linchkit/core ${cap.coreVersion}, but running ${coreVersion}`,
    });
  }

  // PR-1 reports incompatibilities as warnings; `enforceCoreCompatibility`
  // promotes them to `errors` only when `strict` is set.
  return { errors: [], warnings };
}

// ── Enforce ──────────────────────────────────────────────

/**
 * Enforce core compatibility for the resolved capability set.
 *
 * - `strict: true`  → throws a {@link LinchKitError} listing all mismatches.
 * - `strict: false` → logs each mismatch as a warning and returns.
 *
 * SAFETY (Spec 21 / issue #122): core `VERSION` is still `0.0.1` while shipped
 * addons declare ranges like `^0.2.0`, so strict mode would refuse every addon
 * and break the dev boot path. Callers MUST keep strict mode OFF until the core
 * `VERSION` is reconciled with addon declarations. See the guard + TODO in
 * `packages/cli/src/commands/dev.ts`.
 */
export function enforceCoreCompatibility(
  caps: CompatCapability[],
  coreVersion: string,
  options: EnforceCoreCompatibilityOptions,
): void {
  const { strict, logger = defaultLogger } = options;
  const { warnings } = checkCoreCompatibility(caps, coreVersion);

  if (warnings.length === 0) return;

  if (strict) {
    const lines = warnings.map((w) => `  - ${w.detail}`).join("\n");
    throw new LinchKitError(
      {
        code: "capability.compatibility.core_version_mismatch",
        message: `Incompatible capabilities for @linchkit/core ${coreVersion}:\n${lines}`,
        details: { coreVersion, mismatches: warnings },
      },
      "system",
    );
  }

  for (const w of warnings) {
    logger.warn(`[compat] ${w.detail}`, {
      capability: w.capability,
      required: w.required,
      actual: w.actual,
    });
  }
}
