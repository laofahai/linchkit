/**
 * Transport Adapter type definitions
 *
 * Transport adapters register new protocol entry points for CommandLayer.
 * They are provided by adapter capabilities (e.g. cap-adapter-server, cap-adapter-mcp).
 * Core only defines the contract; concrete implementations live in capabilities.
 */

import type { AIAuditLogger } from "../ai/ai-audit";
import type { AIBoundary } from "../ai/ai-boundary";
import type { CacheManager } from "../cache/cache-manager";
import type { ConfigRegistry } from "../config/config-registry";
import type { EnvironmentConfig } from "../deployment/environment";
import type { HealthCheckRegistry } from "../deployment/health-check";
import type { ActionExecutor, DataProvider } from "../engine/action-engine";
import type { ApprovalEngine } from "../engine/approval-engine";
import type { CommandLayer, MiddlewareRegistration } from "../engine/command-layer";
import type { PermissionRegistry } from "../engine/permission-engine";
import type { DerivedPropertyEngine } from "../entity/derived-property";
import type { EntityRegistry } from "../entity/entity-registry";
import type { RelationRegistry } from "../entity/relation-registry";
import type { EventBus } from "../event/event-bus";
import type { FlowEngine, FlowRegistry } from "../flow/types";
import type { EvolutionRuntime } from "../life-system/runtime";
import type { OntologyRegistry } from "../ontology";
import type { ActionDefinition } from "./action";
import type { AIService, AIServiceConfig } from "./ai";
import type { CapabilityDefinition } from "./capability";
import type { EntityDefinition } from "./entity";
import type { ExecutionLogger } from "./execution-log";
import type { RelationDefinition } from "./relation";
import type { StateDefinition } from "./state";
import type { ViewDefinition } from "./view";

/** Runtime context passed to transport factory */
export interface TransportContext {
  commandLayer: CommandLayer;
  executor: ActionExecutor;
  entityRegistry: EntityRegistry;
  entities: EntityDefinition[];
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
  links?: RelationDefinition[];
  /** Link registry with all links (explicit + implicit) registered */
  relationRegistry?: RelationRegistry;
  /** Permission registry — auto-built from capabilities' extensions.permissionGroups */
  permissionRegistry?: PermissionRegistry;
  /** Loaded capability definitions — used by transports to inspect loaded capabilities */
  capabilities?: CapabilityDefinition[];
  /** Flow registry with all registered flows */
  flowRegistry?: FlowRegistry;
  /** Flow engine — used for starting, querying, and cancelling flow instances */
  flowEngine?: FlowEngine;
  /** Ontology registry — unified semantic facade over all registries */
  ontologyRegistry?: OntologyRegistry;
  /** Cache manager — multi-layer cache with event-driven invalidation */
  cacheManager?: CacheManager;
  /** Health check registry — liveness and readiness probes */
  healthCheckRegistry?: HealthCheckRegistry;
  /** Derived property engine — computes store/compute-strategy derived fields */
  derivedPropertyEngine?: DerivedPropertyEngine;
  /** Detected environment config with feature flags */
  environment?: EnvironmentConfig;
  /** AI boundary engine — enforces safety constraints on AI operations */
  aiBoundary?: AIBoundary;
  /** AI audit logger — tracks all AI decisions for compliance */
  aiAuditLogger?: AIAuditLogger;
  /** AI service — provides LLM completion and streaming capabilities */
  aiService?: AIService;
  /** AI service config — raw config for resolving language models directly */
  aiConfig?: AIServiceConfig;
  /**
   * Evolution runtime — Spec 55 life-system pipeline (Sense→Memory→Awareness→Insight).
   * Transports (MCP, HTTP) use this to trigger evolution cycles, list insights,
   * and manage proposals. Constructed by the CLI dev wiring after the
   * execution logger so its query helper can route execution_log lookups
   * to the right backend (Drizzle or in-memory).
   */
  evolutionRuntime?: EvolutionRuntime;
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
