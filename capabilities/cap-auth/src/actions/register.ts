/**
 * Register action
 *
 * Creates a new user account with email/password credentials.
 * The handler is wired in the factory — hashes password and stores user.
 */

import { defineAction } from "@linchkit/core";

export const registerAction = defineAction({
  name: "register",
  schema: "user",
  label: "Register",
  description: "Create a new user account",
  input: {
    name: {
      type: "string",
      label: "Name",
      required: true,
    },
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
  // Handler wired by factory — registers user with hashed password
});
