/**
 * Environment Detection and Configuration — Dev / Staging / Production.
 *
 * Detects the current runtime environment and provides environment-specific
 * defaults for feature flags, logging, and validation behavior.
 */

// ── Types ────────────────────────────────────────────────

export type EnvironmentName = "development" | "staging" | "production" | "test";

export interface EnvironmentFeatureFlags {
  /** Enable verbose debug logging (default: true in dev/test) */
  verboseLogging: boolean;
  /** Enable strict validation (schema + action input checks) (default: true in prod/staging) */
  strictValidation: boolean;
  /**
   * Escalate proposal-validation Phase 3 breaking-reference findings from WARN
   * to BLOCK (default: true in prod/staging). Sibling of `strictValidation`:
   * legitimate proposals are never blocked in dev/test, but production refuses
   * proposals that break existing references.
   */
  strictCompatibility: boolean;
  /**
   * Escalate proposal-validation Phase 4 generated-source CONTRACT findings (G5)
   * from WARN to BLOCK (default: true in prod/staging). Lock-step sibling of
   * `strictCompatibility`: the checks are heuristic static verifications that an
   * AI-materialized `generatedSource` actually defines the declared target/name,
   * so dev/test stay warn-only while production refuses contract-violating
   * candidate code.
   */
  strictGeneratedContract: boolean;
  /**
   * Escalate proposal-validation Phase 5 execution dry-run CONTENT findings
   * (Spec 70 §7) from WARN to BLOCK. Unlike its strict siblings this flag is
   * **opt-in everywhere — NOT derived from `isProduction`**: the dry-run depends
   * on external sandbox infrastructure, and auto-blocking in prod on an
   * un-configured or flaky sandbox would wedge graduation. Default `false` in
   * EVERY environment; enable explicitly via `LINCHKIT_STRICT_EXECUTION_DRY_RUN=1`
   * only after an operator has confirmed the sandbox is healthy.
   */
  strictExecutionDryRun: boolean;
  /** Enable detailed error messages in responses (default: true in dev/test) */
  detailedErrors: boolean;
  /** Enable hot-reload / watch mode (default: true in dev) */
  hotReload: boolean;
  /** Enable request/response body logging (default: true in dev) */
  requestLogging: boolean;
  /** Enable Drizzle ORM debug logging (default: false, true in dev when explicitly set) */
  databaseDebug: boolean;
  /** Enable CORS permissive mode (default: true in dev) */
  permissiveCors: boolean;
}

export interface EnvironmentConfig {
  /** Detected environment name */
  name: EnvironmentName;
  /** Whether this is a production-like environment (production or staging) */
  isProduction: boolean;
  /** Whether this is a development environment */
  isDevelopment: boolean;
  /** Whether this is a test environment */
  isTest: boolean;
  /** Feature flags with environment-specific defaults */
  features: EnvironmentFeatureFlags;
}

// ── Detection ────────────────────────────────────────────

/**
 * Detect the current environment from env vars.
 *
 * Priority: BUN_ENV > NODE_ENV > default ("development").
 * Normalizes common aliases (e.g. "prod" → "production", "dev" → "development").
 */
export function detectEnvironment(explicit?: EnvironmentName): EnvironmentConfig {
  const name = explicit ?? resolveEnvName();
  return buildConfig(name);
}

/** Resolve environment name from env vars */
function resolveEnvName(): EnvironmentName {
  const raw = process.env.BUN_ENV ?? process.env.NODE_ENV ?? "development";
  return normalizeEnvName(raw);
}

/** Normalize common aliases to canonical names */
function normalizeEnvName(raw: string): EnvironmentName {
  const lower = raw.toLowerCase().trim();
  switch (lower) {
    case "production":
    case "prod":
      return "production";
    case "staging":
    case "stage":
      return "staging";
    case "test":
    case "testing":
      return "test";
    default:
      return "development";
  }
}

/**
 * Resolve the opt-in Phase 5 strict gate from the environment.
 *
 * Mirrors the materialize-path opt-in (`LINCHKIT_EXECUTION_DRY_RUN=1`): the
 * strict gate is enabled ONLY when `LINCHKIT_STRICT_EXECUTION_DRY_RUN === "1"`,
 * regardless of the detected environment (see `strictExecutionDryRun` doc).
 */
function resolveStrictExecutionDryRun(): boolean {
  return process.env.LINCHKIT_STRICT_EXECUTION_DRY_RUN === "1";
}

/** Build full config with feature flags for a given environment */
function buildConfig(name: EnvironmentName): EnvironmentConfig {
  const isProduction = name === "production" || name === "staging";
  const isDevelopment = name === "development";
  const isTest = name === "test";

  return {
    name,
    isProduction,
    isDevelopment,
    isTest,
    features: {
      verboseLogging: isDevelopment || isTest,
      strictValidation: isProduction,
      strictCompatibility: isProduction,
      strictGeneratedContract: isProduction,
      // Opt-in everywhere (Spec 70 §7) — never derived from isProduction.
      strictExecutionDryRun: resolveStrictExecutionDryRun(),
      detailedErrors: isDevelopment || isTest,
      hotReload: isDevelopment,
      requestLogging: isDevelopment,
      databaseDebug: false,
      permissiveCors: isDevelopment,
    },
  };
}

/**
 * Validate that required environment variables are set for production.
 *
 * @param required - List of env var names that must be present.
 * @returns An object with `valid` boolean and list of `missing` var names.
 */
export function validateRequiredEnvVars(required: string[]): { valid: boolean; missing: string[] } {
  const missing = required.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === "";
  });
  return { valid: missing.length === 0, missing };
}
