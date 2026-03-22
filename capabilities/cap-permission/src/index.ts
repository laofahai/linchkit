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
export { createCapPermission } from "./factory";
export type { CapPermissionOptions } from "./factory";
export type { PermissionMiddlewareOptions } from "./middleware/permission-middleware";
// Middleware
export {
  createPermissionMiddleware,
  createPermissionMiddlewareRegistration,
} from "./middleware/permission-middleware";
export { permissionAssignmentSchema } from "./schemas/permission-assignment";
// Schemas
export { permissionGroupSchema } from "./schemas/permission-group";
