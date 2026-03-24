/**
 * Capability type definitions
 *
 * Capability is the modular organizational unit of LinchKit.
 * Types: standard (standalone business module), bridge (cross-module bridge), adapter (external system adapter)
 */

import type { CommandContext } from "../engine/command-layer";
import type { ActionDefinition, ActionOverride } from "./action";
import type { CliCommand } from "./cli";
import type { EventDefinition, EventHandlerDefinition } from "./event";
import type { LinkDefinition } from "./link";
import type { PageRegistration } from "./page";
import type { RuleDefinition, RuleOverride } from "./rule";
import type { SchemaDefinition, SchemaExtension, SchemaOverride } from "./schema";
import type { StateDefinition, StateExtension } from "./state";
import type { PermissionGroupDefinition } from "./permission";
import type { TransportAdapterDefinition } from "./transport";
import type { ViewDefinition, ViewExtension } from "./view";

// ── Auth provider extension ─────────────────────────────

/**
 * Registration record for an auth provider capability.
 *
 * Auth provider capabilities (e.g. cap-auth-better-auth) register via
 * `extensions.authProvider` so that cap-auth can discover the concrete
 * provider at runtime without hardcoded imports in the framework.
 */
export interface AuthProviderRegistration {
  /** Unique provider name (e.g. "better-auth", "firebase", "ldap") */
  name: string;
  /**
   * Factory function that creates the auth provider instance.
   * Receives a context with the database instance (if available).
   */
  // biome-ignore lint/suspicious/noExplicitAny: database type varies by driver
  create: (ctx: { database?: any; dataProvider?: import("../engine/action-engine").DataProvider }) => any;
  /**
   * Optional function to seed an initial admin user.
   * Called after the provider is created during dev startup.
   */
  // biome-ignore lint/suspicious/noExplicitAny: database type varies by driver
  seedAdmin?: (ctx: { database?: any }) => Promise<void>;
}

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
  links?: LinkDefinition[];
  events?: EventDefinition[];
  eventHandlers?: EventHandlerDefinition[];
  views?: ViewDefinition[];
  pages?: PageRegistration[];
  ui?: CapabilityUiDefinition;

  /**
   * Zod schema declaring this capability's config structure.
   * ConfigRegistry validates against it at startup.
   */
  // biome-ignore lint/suspicious/noExplicitAny: ZodObject generic variance
  configSchema?: import("zod").ZodObject<any>;

  /**
   * Config values populated by the factory function.
   * Core resolves env vars and validates against configSchema at startup.
   */
  config?: Record<string, unknown>;

  /** Dev-only seed data keyed by schema name */
  seed?: Record<string, Array<Record<string, unknown>>>;

  // Extension points (for Bridge / Adapter)
  extensions?: CapabilityExtensions;

  // System permission declarations
  systemPermissions?: SystemPermission[];
}

/** Extension points a capability can register */
export interface CapabilityExtensions {
  /** Schema extensions (for Bridge / Adapter) */
  schemas?: Array<{ target: string; extension: SchemaExtension }>;
  schemaOverrides?: Array<{ target: string; override: SchemaOverride }>;
  actions?: Array<{ target: string; override: ActionOverride }>;
  rules?: Array<{ target: string; override: RuleOverride }>;
  states?: Array<{ target: string; extension: StateExtension }>;
  views?: Array<{ target: string; extension: ViewExtension }>;
  middlewares?: CapabilityMiddlewareRegistration[];
  /** CLI commands registered by this capability */
  commands?: CliCommand[];
  /** Transport adapters (protocol entry points for CommandLayer) */
  transports?: TransportAdapterDefinition[];
  /** Auth provider registration (only one provider can be active at a time) */
  authProvider?: AuthProviderRegistration;
  /** Permission groups declared by this capability (auto-registered at startup) */
  permissionGroups?: PermissionGroupDefinition[];
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
