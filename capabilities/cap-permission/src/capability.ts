/**
 * cap-permission capability definition
 *
 * Permission management capability providing group definitions,
 * user-to-group assignments, and the Command Layer "permission" slot middleware.
 */

import { defineCapability } from "@linchkit/core";
import { assignUserAction } from "./actions/assign-user";
import { createGroupAction } from "./actions/create-group";
import { revokeUserAction } from "./actions/revoke-user";
import { updatePermissionsAction } from "./actions/update-permissions";
import { capPermissionConfig } from "./config";
import { permissionAssignmentSchema } from "./schemas/permission-assignment";
import { permissionGroupSchema } from "./schemas/permission-group";

export const capPermission = defineCapability({
  name: "cap-permission",
  label: "Permission Management",
  description: "Permission group management, user assignment, and permission slot middleware",
  type: "standard",
  category: "system",
  version: "0.0.1",

  configSchema: capPermissionConfig.schema,

  dependencies: ["cap-auth"],

  schemas: [permissionGroupSchema, permissionAssignmentSchema],
  actions: [createGroupAction, assignUserAction, revokeUserAction, updatePermissionsAction],

  systemPermissions: ["database.read", "database.write", "event.emit"],
});
