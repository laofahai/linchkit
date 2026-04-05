/**
 * Refresh token action
 *
 * Exchanges a valid refresh token for a new access token.
 * The refresh token itself is not rotated in this operation.
 */

import { defineAction } from "@linchkit/core";

export const refreshTokenAction = defineAction({
  name: "refresh_token",
  entity: "token",
  label: "Refresh Token",
  description: "Exchange a refresh token for a new access token",
  input: {
    refresh_token: {
      type: "string",
      label: "Refresh Token",
      required: true,
      sensitive: true,
    },
  },
  output: {
    access_token: { type: "string", label: "Access Token" },
    expires_at: { type: "datetime", label: "Expires At" },
  },
  policy: {
    mode: "sync",
    transaction: false,
  },
  exposure: "all",
  permissions: {
    actorTypes: ["human", "system", "external"],
  },
  // No handler — provided by AuthProvider implementation (e.g. cap-auth-better-auth)
});
