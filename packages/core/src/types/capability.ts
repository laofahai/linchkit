/**
 * Capability type definitions
 *
 * Capability is the modular organizational unit of LinchKit.
 * Types: standard (standalone business module), bridge (cross-module bridge), adapter (external system adapter)
 */

import type { CommandContext } from "../engine/command-layer";
import type { ActionDefinition, ActionOverride } from "./action";
import type { AutomationDefinition } from "./automation";
import type { CliCommand } from "./cli";
import type {
  EntityDefinition,
  EntityExtension,
  EntityOverride,
  InterfaceDefinition,
} from "./entity";
import type { EventDefinition, EventHandlerDefinition } from "./event";
import type { FlowDefinition } from "./flow";
import type { Sensor } from "./life-system";
import type { PageRegistration } from "./page";
import type { PermissionGroupDefinition } from "./permission";
import type { RelationDefinition } from "./relation";
import type { RuleDefinition, RuleOverride } from "./rule";
import type { StateDefinition, StateExtension } from "./state";
import type { TransportAdapterDefinition } from "./transport";
import type { ViewDefinition, ViewExtension } from "./view";

// ── Menu item registration ──────────────────────────────

/** Menu item contributed by a capability for sidebar navigation */
export interface MenuItemRegistration {
  /** Unique identifier */
  id: string;
  /** Display label (supports i18n via "t:" prefix, e.g. "t:health.title") */
  label: string;
  /** URL path (e.g., "/admin/health") */
  path: string;
  /** Lucide icon name (PascalCase, e.g. "HeartPulse") */
  icon?: string;
  /** Menu section: "main" (schemas area), "admin" (administration area) */
  section?: "main" | "admin";
  /** Sort order within section (lower = earlier) */
  order?: number;
  /** Auth requirement */
  auth?: "required" | "anonymous" | "optional";
}

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
  create: (ctx: {
    // biome-ignore lint/suspicious/noExplicitAny: database type varies by driver
    database?: any;
    dataProvider?: import("../engine/action-engine").DataProvider;
    // biome-ignore lint/suspicious/noExplicitAny: return type varies by auth provider
  }) => any;
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

  /**
   * Addon group identifier. Capabilities with the same group are
   * co-located in a directory and can be split into an independent repository.
   * Purely organizational — runtime does not depend on it.
   */
  group?: string;

  /**
   * When true, this capability is automatically activated if ALL
   * entries in `dependencies` are present in the active capability set.
   * Analogous to Odoo's auto_install flag.
   * @default false
   */
  autoInstall?: boolean;

  /**
   * Bridge loading priority (higher number = later execution = outer layer in onion model).
   * Primarily used for bridge capabilities to control initialization order.
   * @default 0
   */
  priority?: number;

  /**
   * For bridge capabilities, declares which capabilities this bridge connects.
   * Each entry references a capability by name.
   */
  bridges?: Array<{ capability: string }>;

  interfaces?: InterfaceDefinition[];
  entities?: EntityDefinition[];
  actions?: ActionDefinition[];
  rules?: RuleDefinition[];
  states?: StateDefinition[];
  relations?: RelationDefinition[];
  events?: EventDefinition[];
  eventHandlers?: EventHandlerDefinition[];
  views?: ViewDefinition[];
  pages?: PageRegistration[];
  flows?: FlowDefinition[];
  automations?: AutomationDefinition[];
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

/** GraphQL schema extension contributed by a capability */
export interface GraphQLExtensionRegistration {
  /** Query fields to merge into the root Query type */
  queryFields?: Record<string, import("graphql").GraphQLFieldConfig<unknown, unknown>>;
  /** Mutation fields to merge into the root Mutation type */
  mutationFields?: Record<string, import("graphql").GraphQLFieldConfig<unknown, unknown>>;
}

/** Extension points a capability can register */
export interface CapabilityExtensions {
  /** Entity extensions (for Bridge / Adapter) */
  entities?: Array<{ target: string; extension: EntityExtension }>;
  entityOverrides?: Array<{ target: string; override: EntityOverride }>;
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
  /** Menu items for sidebar navigation */
  menuItems?: MenuItemRegistration[];
  /** Custom field type registrations */
  fieldTypes?: Array<{
    name: string;
    label?: string;
    drizzleType?: string;
    graphqlType?: string;
  }>;
  /** Custom view type registrations */
  viewTypes?: Array<{ name: string; label?: string; component?: string }>;
  /** Custom rule effect type registrations */
  ruleEffects?: Array<{
    name: string;
    label?: string;
    handler: (
      effect: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Promise<void> | void;
  }>;
  /** Service registrations (singleton services available via DI) */
  services?: Array<{ name: string; factory: (...args: unknown[]) => unknown }>;
  /** Lifecycle hooks */
  hooks?: Array<{
    event: string;
    handler: (...args: unknown[]) => Promise<void> | void;
    priority?: number;
  }>;
  /** Sensors registered by this capability for the Sense layer (Spec 55 §3.3) */
  sensors?: Sensor[];
  /** GraphQL schema extensions — query/mutation fields merged into the main schema */
  graphqlExtensions?: GraphQLExtensionRegistration;
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
