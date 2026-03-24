/**
 * Command Layer type definitions
 *
 * All entry points (CLI, MCP, HTTP API, UI) go through the same Command Layer.
 * Core logic is written once; different transport protocols are just adapters.
 */

import type { ActionDefinition, ActionResult } from "./action";
import type { CapabilityDefinition } from "./capability";
import type { RuleDefinition } from "./rule";
import type { SchemaDefinition } from "./schema";
import type { StateDefinition } from "./state";
import type { ViewDefinition } from "./view";

// ── Unified response format ────────────────────────────────────

export interface CommandResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  warnings?: string[];
  meta?: {
    executionId?: string;
    duration?: number;
  };
}

// ── Command Registry ────────────────────────────────

export interface CommandRegistry {
  // Action execution
  execute_action: (name: string, input: Record<string, unknown>) => Promise<ActionResult>;
  batch_actions: (
    actions: Array<{ name: string; input: Record<string, unknown> }>,
  ) => Promise<ActionResult[]>;

  // Data query
  query: (graphql: string, variables?: Record<string, unknown>) => Promise<unknown>;

  // Capability queries
  list_capabilities: () => Promise<CapabilityDefinition[]>;
  get_capability: (name: string) => Promise<CapabilityDefinition>;
  get_schema: (name: string) => Promise<SchemaDefinition>;
  get_actions: (capability: string) => Promise<ActionDefinition[]>;
  get_rules: (capability: string) => Promise<RuleDefinition[]>;
  get_state_machine: (name: string) => Promise<StateDefinition>;
  get_views: (capability: string) => Promise<ViewDefinition[]>;
}

// ── Query-related ────────────────────────────────────────

export interface PaginationInput {
  page: number;
  pageSize: number;
}

export interface SortInput {
  field: string;
  order: "asc" | "desc";
}

export interface PaginatedResult<T> {
  total: number;
  items: T[];
  page: number;
  pageSize: number;
}
