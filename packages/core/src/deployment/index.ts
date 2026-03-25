/**
 * Deployment utilities — Health checks, graceful shutdown, environment detection.
 *
 * Server-only module. Used by the server adapter and CLI for production deployments.
 */

export {
  type AggregatedHealthStatus,
  createDatabaseCheck,
  createSchemaCheck,
  type HealthCheckFn,
  type HealthCheckRegistryOptions,
  type HealthCheckResult,
  HealthCheckRegistry,
  type HealthStatus,
  livenessCheck,
} from "./health-check";

export {
  GracefulShutdownManager,
  type GracefulShutdownManagerOptions,
  type ShutdownHook,
  type ShutdownPhase,
  type ShutdownStatus,
} from "./graceful-shutdown";

export {
  detectEnvironment,
  type EnvironmentConfig,
  type EnvironmentFeatureFlags,
  type EnvironmentName,
  validateRequiredEnvVars,
} from "./environment";
