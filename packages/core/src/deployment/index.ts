/**
 * Deployment utilities — Health checks, graceful shutdown, environment detection, build pipeline.
 *
 * Server-only module. Used by the server adapter and CLI for production deployments.
 */

export {
  type BuildConfig,
  type BuildPhase,
  type BuildResult,
  DeployBuilder,
  type ExecResult,
  type ProcessExecutor,
} from "./builder";

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
  createEntityCheck,
  createEventBusCheck,
  type HealthCheckFn,
  HealthCheckRegistry,
  type HealthCheckRegistryOptions,
  type HealthCheckResult,
  type HealthStatus,
  livenessCheck,
} from "./health-check";
export {
  type DeployEvent,
  type DeployWebhookConfig,
  DeployWebhookHandler,
  type WebhookHandleResult,
} from "./webhook-handler";
