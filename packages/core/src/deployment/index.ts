/**
 * Deployment utilities — Health checks, graceful shutdown, environment detection, build pipeline,
 * blue-green instance switching.
 *
 * Server-only module. Used by the server adapter and CLI for production deployments.
 */

export {
  type BlueGreenConfig,
  BlueGreenDeployer,
  type DeployPhase,
  type DeployResult,
  type HttpFetcher,
  type NginxReloader,
  type ProcessHandle,
  type ProcessLauncher,
} from "./blue-green-deployer";

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
  createDeployRollbackOrchestrator,
  DeployRollbackOrchestrator,
  type DeployRollbackOrchestratorOptions,
  type RollbackGhRunner,
  type RollbackGitRunner,
  type RollbackInput,
  type RollbackResult,
  type RollbackRunResult,
} from "./rollback-orchestrator";
export {
  type DeployArtifact,
  type NodeDeployClient,
  type NodeDeployStatus,
  type NodePhase,
  RollingUpdateCoordinator,
  type RollingUpdateCoordinatorConfig,
  type RollingUpdatePhase,
  type RollingUpdateResult,
  type RollingUpdateRollbackResult,
} from "./rolling-update";
export {
  type DeployEvent,
  type DeployWebhookConfig,
  DeployWebhookHandler,
  type WebhookHandleResult,
} from "./webhook-handler";
