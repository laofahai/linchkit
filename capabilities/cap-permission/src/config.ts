/**
 * cap-permission configuration schema
 *
 * Declares config keys for the permission middleware.
 * The PermissionRegistry itself is a programmatic dependency and stays in options.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capPermissionConfig = defineConfigSchema("cap-permission", {
  publicActions: z.array(z.string()).default([]).describe("Actions that skip permission check"),
});
