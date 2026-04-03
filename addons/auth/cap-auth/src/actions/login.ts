/**
 * Login action
 *
 * Authenticates a user with email/password credentials.
 * Creates a new session and returns access + refresh tokens.
 */

import { defineAction } from "@linchkit/core";

export const loginAction = defineAction({
  name: "login",
  schema: "session",
  label: "Login",
  description: "Authenticate user with email and password",
  input: {
    email: {
      type: "string",
      label: "Email",
      required: true,
      format: "email",
    },
    password: {
      type: "string",
      label: "Password",
      required: true,
      sensitive: true,
    },
  },
  output: {
    access_token: { type: "string", label: "Access Token" },
    refresh_token: { type: "string", label: "Refresh Token" },
    expires_in: { type: "number", label: "Expires In (seconds)" },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: false,
  },
  exposure: "all",
  permissions: {
    actorTypes: ["human", "system", "external"],
  },
  // No handler — provided by AuthProvider implementation (e.g. cap-auth-better-auth)
});
