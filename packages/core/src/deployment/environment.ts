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
