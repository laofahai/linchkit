/**
 * Config center — unified config declaration, validation, and access.
 */

export { ConfigRegistry } from "./config-registry";
export type {
  ConfigEntry,
  ConfigScope,
  ConfigScopeRef,
  ConfigStore,
  ConfigVersion,
  SetConfigOptions,
} from "./config-store";
export { InMemoryConfigStore, resolveWithCascade } from "./config-store";
export type { ConfigSchemaRef } from "./define-config-schema";
export { defineConfigSchema } from "./define-config-schema";
export type { ConfigValueHistoryEntry } from "./runtime-config-registry";
export { ConfigValidationError, RuntimeConfigRegistry } from "./runtime-config-registry";
export { databaseConfig, queueConfig, securityConfig, serverConfig } from "./system-schemas";
