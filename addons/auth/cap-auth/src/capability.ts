/**
 * cap-auth capability definition — pure contract layer
 *
 * This is the static capability definition with schemas, action shapes,
 * and state machines, but NO action handlers. Handlers are provided by
 * a concrete AuthProvider via createCapAuth().
 *
 * Use this export for:
 * - Type-checking and schema registration
 * - Inspecting the capability structure (CLI, devtools)
 * - Testing without a concrete provider
 *
 * For production use, prefer createCapAuth({ provider }) which wires
 * action handlers and middleware from a concrete AuthProvider.
 */

import { defineCapability } from "@linchkit/core";
import { createApiKeyAction } from "./actions/create-api-key";
import { loginAction } from "./actions/login";
import { logoutAction } from "./actions/logout";
import { refreshTokenAction } from "./actions/refresh-token";
import { resetPasswordAction } from "./actions/reset-password";
import { capAuthConfig } from "./config";
import { apiKeySchema } from "./schemas/api-key";
import { sessionSchema } from "./schemas/session";
import { tokenSchema } from "./schemas/token";
import { userSchema } from "./schemas/user";
import { userLifecycleState } from "./states/user-lifecycle";

export const capAuth = defineCapability({
  name: "cap-auth",
  label: "Authentication",
  description: "User authentication, session management, and API key support",
  type: "standard",
  category: "system",
  version: "0.0.1",

  configSchema: capAuthConfig.schema,

  dependencies: [],

  entities: [userSchema, sessionSchema, apiKeySchema, tokenSchema],
  actions: [loginAction, logoutAction, createApiKeyAction, refreshTokenAction, resetPasswordAction],
  states: [userLifecycleState],

  extensions: {
    permissionGroups: [
      {
        name: "system_admin",
        label: "Administrator",
        description: "Full access (bypasses permission checks)",
        permissions: {},
      },
    ],
  },

  pages: [
    {
      name: "auth:login",
      path: "/login",
      label: "Sign In",
      layout: "centered",
      auth: "anonymous",
      component: "auth:login",
      redirectOnFail: "/",
    },
    {
      name: "auth:register",
      path: "/register",
      label: "Register",
      layout: "centered",
      auth: "anonymous",
      component: "auth:register",
      redirectOnFail: "/",
    },
    {
      name: "auth:forgot-password",
      path: "/forgot-password",
      label: "Forgot Password",
      layout: "centered",
      auth: "anonymous",
      component: "auth:forgot-password",
      redirectOnFail: "/",
    },
  ],

  systemPermissions: ["database.read", "database.write", "event.emit"],
});
