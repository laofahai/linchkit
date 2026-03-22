/**
 * Transport Adapter type definitions
 *
 * Transport adapters register new protocol entry points for CommandLayer.
 * They are provided by adapter capabilities (e.g. cap-adapter-server, cap-adapter-mcp).
 * Core only defines the contract; concrete implementations live in capabilities.
 */

import type { ActionExecutor, DataProvider } from "../engine/action-engine";
import type { CommandLayer, MiddlewareRegistration } from "../engine/command-layer";
import type { EventBus } from "../engine/event-bus";
import type { SchemaRegistry } from "../engine/schema-registry";
import type { ActionDefinition } from "./action";
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
  /** Runtime config (from linchkit.config.ts) */
  config: Record<string, unknown>;
  /** Pre-built data provider (e.g. DrizzleDataProvider when DATABASE_URL is configured) */
  dataProvider?: DataProvider;
  /** Event bus — PersistentEventBus when DB is available, plain EventBus otherwise */
  eventBus?: EventBus;
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
