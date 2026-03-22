/**
 * Capability type definitions
 *
 * Capability is the modular organizational unit of LinchKit.
 * Types: standard (standalone business module), bridge (cross-module bridge), adapter (external system adapter)
 */

import type { CommandContext } from "../engine/command-layer";
import type { ActionDefinition, ActionOverride } from "./action";
import type { EventDefinition, EventHandlerDefinition } from "./event";
import type { PageRegistration } from "./page";
import type { RuleDefinition, RuleOverride } from "./rule";
import type { SchemaDefinition, SchemaExtension, SchemaOverride } from "./schema";
import type { StateDefinition, StateExtension } from "./state";
import type { ViewDefinition, ViewExtension } from "./view";

// ── Capability types ────────────────────────────────

export type CapabilityType = "standard" | "bridge" | "adapter";

export type CapabilityCategory = "business" | "system" | "integration" | (string & {});

export interface CapabilityUiDefinition {
  /**
   * CSS entrypoints that the host app should import when this capability is installed.
   * Prefer package export paths such as "@linchkit/cap-foo/styles.css".
   */
  styles?: string[];
}

// ── Capability definition ────────────────────────────────

export interface CapabilityDefinition {
  name: string;
  label: string;
  description?: string;
  type: CapabilityType;
  category: CapabilityCategory;
  version: string;

  dependencies?: string[];

  schemas?: SchemaDefinition[];
  actions?: ActionDefinition[];
  rules?: RuleDefinition[];
  states?: StateDefinition[];
  events?: EventDefinition[];
  eventHandlers?: EventHandlerDefinition[];
  views?: ViewDefinition[];
  pages?: PageRegistration[];
  ui?: CapabilityUiDefinition;

  /** Dev-only seed data keyed by schema name */
  seed?: Record<string, Array<Record<string, unknown>>>;

  // Extension points (for Bridge / Adapter)
  extensions?: {
    schemas?: Array<{ target: string; extension: SchemaExtension }>;
    schemaOverrides?: Array<{ target: string; override: SchemaOverride }>;
    actions?: Array<{ target: string; override: ActionOverride }>;
    rules?: Array<{ target: string; override: RuleOverride }>;
    states?: Array<{ target: string; extension: StateExtension }>;
    views?: Array<{ target: string; extension: ViewExtension }>;
    middlewares?: CapabilityMiddlewareRegistration[];
  };

  // System permission declarations
  systemPermissions?: SystemPermission[];
}

// ── Middleware registration (Command Layer slots) ─────────────────

export type SlotName =
  | "pre"
  | "auth"
  | "exposure"
  | "permission"
  | "tenant"
  | "pre-action"
  | "post-action";

/**
 * @deprecated Use MiddlewareRegistration from engine/command-layer instead.
 * Kept for backward compatibility — the command-layer version has name + order fields.
 */
export interface CapabilityMiddlewareRegistration {
  slot: SlotName;
  handler: (ctx: CommandContext, next: () => Promise<void>) => Promise<void>;
  priority?: number;
}

// ── System permissions ────────────────────────────────────────

export type SystemPermission =
  | "db:read"
  | "db:write"
  | "event:emit"
  | "action:execute"
  | "file:read"
  | "file:write"
  | "network:outbound"
  | (string & {});
