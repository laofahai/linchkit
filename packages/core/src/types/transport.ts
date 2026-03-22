/**
 * Transport Adapter type definitions
 *
 * Transport adapters register new protocol entry points for CommandLayer.
 * They are provided by adapter capabilities (e.g. cap-adapter-server, cap-adapter-mcp).
 * Core only defines the contract; concrete implementations live in capabilities.
 */

import type { ActionExecutor } from "../engine/action-engine";
import type { CommandLayer } from "../engine/command-layer";
import type { SchemaRegistry } from "../engine/schema-registry";
import type { ActionDefinition } from "./action";
import type { SchemaDefinition } from "./schema";

/** Runtime context passed to transport factory */
export interface TransportContext {
  commandLayer: CommandLayer;
  executor: ActionExecutor;
  schemaRegistry: SchemaRegistry;
  schemas: SchemaDefinition[];
  actions: ActionDefinition[];
  /** Runtime config (from linchkit.config.ts) */
  config: Record<string, unknown>;
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
