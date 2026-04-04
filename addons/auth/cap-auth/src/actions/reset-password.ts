/**
 * Reset password action
 *
 * Two-phase password reset flow:
 * Phase 1 (request): Send a reset email given an email address
 * Phase 2 (reset): Validate token and set new password
 */

import { defineAction } from "@linchkit/core";

export const resetPasswordAction = defineAction({
  name: "reset_password",
  entity: "user",
  label: "Reset Password",
  description: "Request or complete a password reset",
  input: {
    email: {
      type: "string",
      label: "Email",
      format: "email",
      description: "Email address to send reset link (phase 1)",
    },
    token: {
      type: "string",
      label: "Reset Token",
      sensitive: true,
      description: "Password reset token from email (phase 2)",
    },
    new_password: {
      type: "string",
      label: "New Password",
      sensitive: true,
      description: "New password to set (phase 2)",
    },
  },
  output: {
    success: { type: "boolean", label: "Success" },
  },
  policy: {
    mode: "async",
    transaction: true,
  },
  exposure: "all",
  permissions: {
    actorTypes: ["human", "system", "external"],
  },
  // No handler — provided by AuthProvider implementation (e.g. cap-auth-better-auth)
});
