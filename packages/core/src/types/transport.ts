/**
 * Transport Adapter type definitions
 *
 * Transport adapters register new protocol entry points for CommandLayer.
 * They are provided by adapter capabilities (e.g. cap-adapter-server, cap-adapter-mcp).
 * Core only defines the contract; concrete implementations live in capabilities.
 */

import type { CacheManager } from "../cache/cache-manager";
import type { ConfigRegistry } from "../config/config-registry";
import type { EnvironmentConfig } from "../deployment/environment";
import type { HealthCheckRegistry } from "../deployment/health-check";
import type { ActionExecutor, DataProvider } from "../engine/action-engine";
import type { ApprovalEngine } from "../engine/approval-engine";
import type { CommandLayer, MiddlewareRegistration } from "../engine/command-layer";
import type { PermissionRegistry } from "../engine/permission-engine";
import type { EventBus } from "../event/event-bus";
import type { FlowRegistry } from "../flow/types";
import type { OntologyRegistry } from "../ontology";
import type { LinkRegistry } from "../schema/link-registry";
import type { SchemaRegistry } from "../schema/schema-registry";
import type { ActionDefinition } from "./action";
import type { CapabilityDefinition } from "./capability";
import type { ExecutionLogger } from "./execution-log";
import type { LinkDefinition } from "./link";
import type { SchemaDefinition } from "./schema";
import type { StateDefinition } from "./state";
import type { ViewDefinition } from "./view";

/** Runtime context passed to transport factory */
export interface TransportContext {
  commandLayer: CommandLayer;
  executor: ActionExecutor;
  schemaRegistry: SchemaRegistry;
  schemas: SchemaDefinition[];
  actions: ActionDefinition[];
  views: ViewDefinition[];
  states: StateDefinition[];
  middlewares: MiddlewareRegistration[];
  /** Unified config registry (replaces raw config object) */
  config: ConfigRegistry;
  /** Pre-built data provider (e.g. DrizzleDataProvider when DATABASE_URL is configured) */
  dataProvider?: DataProvider;
  /** Event bus — PersistentEventBus when DB is available, plain EventBus otherwise */
  eventBus?: EventBus;
  /** Execution logger — DrizzleExecutionLogger when DB is available, InMemory otherwise */
  executionLogger?: ExecutionLogger;
  /** Approval engine — wired with DrizzleApprovalStore when DB is available */
  approvalEngine?: ApprovalEngine;
  /** Link definitions for generating bidirectional relation resolver fields */
  links?: LinkDefinition[];
  /** Link registry with all links (explicit + implicit) registered */
  linkRegistry?: LinkRegistry;
  /** Permission registry — auto-built from capabilities' extensions.permissionGroups */
  permissionRegistry?: PermissionRegistry;
  /** Loaded capability definitions — used by transports to inspect loaded capabilities */
  capabilities?: CapabilityDefinition[];
  /** Flow registry with all registered flows */
  flowRegistry?: FlowRegistry;
  /** Ontology registry — unified semantic facade over all registries */
  ontologyRegistry?: OntologyRegistry;
  /** Cache manager — multi-layer cache with event-driven invalidation */
  cacheManager?: CacheManager;
  /** Health check registry — liveness and readiness probes */
  healthCheckRegistry?: HealthCheckRegistry;
  /** Detected environment config with feature flags */
  environment?: EnvironmentConfig;
}

/** Lifecycle handle returned by transport factory */
export interface TransportLifecycle {
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
}

/** Transport adapter definition registered via extensions.transports */
export interface TransportAdapterDefinition {
  /** Unique transport name (e.g. 'http', 'mcp', 'a2a') */
  name: string;
  /** Human-readable label */
  label?: string;
  /** Factory function — receives runtime context, returns lifecycle handle */
  factory: (ctx: TransportContext) => Promise<TransportLifecycle> | TransportLifecycle;
  /** Optional: mount HTTP routes on the main server (for transports that need HTTP endpoints) */
  routes?: (app: unknown) => void;
  /** Transport-specific configuration schema */
  config?: Record<string, TransportConfigField>;
}

export interface TransportConfigField {
  type: "string" | "number" | "boolean";
  default?: unknown;
  description?: string;
  /** Mark as secret (e.g. bearer tokens) */
  secret?: boolean;
}
