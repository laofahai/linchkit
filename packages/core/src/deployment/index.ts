/**
 * Deployment utilities — Health checks, graceful shutdown, environment detection.
 *
 * Server-only module. Used by the server adapter and CLI for production deployments.
 */

export {
  detectEnvironment,
  type EnvironmentConfig,
  type EnvironmentFeatureFlags,
  type EnvironmentName,
  validateRequiredEnvVars,
} from "./environment";

export {
  GracefulShutdownManager,
  type GracefulShutdownManagerOptions,
  type ShutdownHook,
  type ShutdownPhase,
  type ShutdownStatus,
} from "./graceful-shutdown";
export {
  type AggregatedHealthStatus,
  createCacheCheck,
  createDatabaseCheck,
  createEventBusCheck,
  createSchemaCheck,
  type HealthCheckFn,
  HealthCheckRegistry,
  type HealthCheckRegistryOptions,
  type HealthCheckResult,
  type HealthStatus,
  livenessCheck,
} from "./health-check";
