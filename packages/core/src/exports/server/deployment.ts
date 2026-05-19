/**
 * Deployment runtime — health checks, graceful shutdown, environment,
 * deploy webhooks (server-only).
 */

export {
  type AggregatedHealthStatus,
  createCacheCheck,
  createDatabaseCheck,
  createEntityCheck,
  createEventBusCheck,
  type DeployEvent,
  type DeployWebhookConfig,
  DeployWebhookHandler,
  detectEnvironment,
  type EnvironmentConfig,
  type EnvironmentFeatureFlags,
  type EnvironmentName,
  GracefulShutdownManager,
  type GracefulShutdownManagerOptions,
  type HealthCheckFn,
  HealthCheckRegistry,
  type HealthCheckRegistryOptions,
  type HealthCheckResult,
  type HealthStatus,
  livenessCheck,
  type ShutdownHook,
  type ShutdownPhase,
  type ShutdownStatus,
  validateRequiredEnvVars,
  type WebhookHandleResult,
} from "../../deployment";
