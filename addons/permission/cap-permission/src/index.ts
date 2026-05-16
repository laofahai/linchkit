/**
 * @linchkit/cap-permission — Permission management capability
 *
 * Provides permission group management, user-to-group assignments,
 * and the permission slot middleware for the Command Layer.
 */

export { assignUserAction } from "./actions/assign-user";
// Actions
export { createGroupAction } from "./actions/create-group";
export { revokeUserAction } from "./actions/revoke-user";
export { updatePermissionsAction } from "./actions/update-permissions";
// Capability definition
export { capPermission } from "./capability";
// Config schema
export { capPermissionConfig } from "./config";
// Permission group definition — Phase 1 (spec 10 §2.1)
export type {
  DataAccessCondition,
  EntityGrant,
  GrantMap,
  PermissionConstraints,
  PermissionGroupDefinition,
  PermissionValue,
  SchemaPermissions,
} from "./define-permission-group";
export { definePermissionGroup } from "./define-permission-group";
export type { CapPermissionOptions } from "./factory";
export { createCapPermission } from "./factory";
export type { PermissionMiddlewareOptions } from "./middleware/permission-middleware";
// Middleware
export {
  createPermissionMiddleware,
  createPermissionMiddlewareRegistration,
} from "./middleware/permission-middleware";
// Permission group chain builder — Phase 1 (spec 10 §2.1)
export type { PermissionGroupBuilder } from "./permission-group-builder";
export { permissionGroup } from "./permission-group-builder";
export { permissionAssignmentSchema } from "./schemas/permission-assignment";
// Schemas
export { permissionGroupSchema } from "./schemas/permission-group";
