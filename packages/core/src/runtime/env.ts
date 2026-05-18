/**
 * Environment variable validation — Spec 12 deployment foundation.
 *
 * Pure function that audits an env-like record (supplied by the caller, not
 * read from `process.env` directly). The caller is responsible for passing
 * `process.env` (or any other map) so that this module stays trivially
 * testable, deterministic, and safe to use in browsers, edge runtimes, or
 * sandboxed test harnesses.
 *
 * Required variables (a deployment that omits them is rejected):
 *   - DATABASE_URL — Postgres connection string used by DrizzleDataProvider.
 *   - JWT_SECRET   — Secret used to sign / verify auth tokens.
 *
 * Inspected but not required:
 *   - NODE_ENV     — Used only to emit a warning when the value is unknown.
 *                    `validateEnv` accepts a missing NODE_ENV (defaulting
 *                    behaviour lives in `detectEnvironment`).
 *
 * Optional but commonly-set variables: emit a warning when omitted in a
 * production-like NODE_ENV to nudge operators toward observability + cache:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT
 *   - REDIS_URL
 */

// ── Constants ────────────────────────────────────────────

/** Variables that must be present and non-empty. */
export const REQUIRED_ENV_VARS: readonly string[] = ["DATABASE_URL", "JWT_SECRET"] as const;

/** Variables that are inspected but never required. */
export const OPTIONAL_ENV_VARS: readonly string[] = [
  "NODE_ENV",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "REDIS_URL",
] as const;

/** Recognised NODE_ENV values (anything else emits a warning). */
const KNOWN_NODE_ENVS: readonly string[] = ["development", "production", "staging", "test"];

/** NODE_ENV values that should nudge operators to wire observability + cache. */
const PRODUCTION_LIKE_NODE_ENVS: readonly string[] = ["production", "staging"];

// ── Types ────────────────────────────────────────────────

export interface EnvValidationResult {
  /** True when every required variable is present and non-empty. */
  ok: boolean;
  /** Names of required variables that were missing or empty. */
  missing: string[];
  /**
   * Non-fatal observations: e.g. unknown NODE_ENV, missing OTEL/Redis
   * endpoints in a production-like environment, suspiciously weak JWT secret.
   */
  warnings: string[];
}

// ── Pure validator ───────────────────────────────────────

/**
 * Validate an env-like record. Pure — does not read `process.env`.
 *
 * @param input - The env map (caller passes `process.env` or any subset).
 * @returns A structured result with required-var status + soft warnings.
 */
export function validateEnv(input: Record<string, string | undefined>): EnvValidationResult {
  const missing: string[] = [];
  for (const name of REQUIRED_ENV_VARS) {
    const value = input[name];
    if (value === undefined || value === "") {
      missing.push(name);
    }
  }

  const warnings: string[] = [];
  const nodeEnv = input.NODE_ENV;
  if (nodeEnv !== undefined && nodeEnv !== "" && !KNOWN_NODE_ENVS.includes(nodeEnv)) {
    warnings.push(
      `NODE_ENV="${nodeEnv}" is not one of ${KNOWN_NODE_ENVS.join(", ")}; defaulting behaviour may apply.`,
    );
  }

  const productionLike = nodeEnv !== undefined && PRODUCTION_LIKE_NODE_ENVS.includes(nodeEnv);
  if (productionLike) {
    if (!input.OTEL_EXPORTER_OTLP_ENDPOINT) {
      warnings.push(
        "OTEL_EXPORTER_OTLP_ENDPOINT is not set; OpenTelemetry traces will be dropped.",
      );
    }
    if (!input.REDIS_URL) {
      warnings.push(
        "REDIS_URL is not set; cache will fall back to in-memory only (no cross-instance coherence).",
      );
    }
  }

  const jwtSecret = input.JWT_SECRET;
  if (jwtSecret !== undefined && jwtSecret !== "" && jwtSecret.length < 32) {
    warnings.push("JWT_SECRET is shorter than 32 characters; consider a longer secret.");
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
  };
}
