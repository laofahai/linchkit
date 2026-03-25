/**
 * Config center — unified config declaration, validation, and access.
 */

export { ConfigRegistry } from "./config-registry";
export type { ConfigSchemaRef } from "./define-config-schema";
export { defineConfigSchema } from "./define-config-schema";
export { ConfigValidationError, RuntimeConfigRegistry } from "./runtime-config-registry";
export { databaseConfig, queueConfig, securityConfig, serverConfig } from "./system-schemas";
