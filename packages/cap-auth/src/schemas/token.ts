/**
 * Token schema definition
 *
 * Tracks JWT access and refresh tokens. Each login creates token records
 * that can be validated, refreshed, or revoked.
 */

import { defineSchema } from "@linchkit/core";

export const tokenSchema = defineSchema({
  name: "token",
  label: "Token",
  description: "JWT access and refresh token record",
  fields: {
    user_id: {
      type: "ref",
      label: "User",
      target: "user",
      required: true,
    },
    token_hash: {
      type: "string",
      label: "Token Hash",
      required: true,
      sensitive: true,
      secret: true,
      description: "SHA-256 hash of the token value",
    },
    type: {
      type: "enum",
      label: "Token Type",
      required: true,
      options: [
        { value: "access", label: "Access" },
        { value: "refresh", label: "Refresh" },
      ],
      description: "Whether this is an access token or a refresh token",
    },
    expires_at: {
      type: "datetime",
      label: "Expires At",
      required: true,
    },
    revoked_at: {
      type: "datetime",
      label: "Revoked At",
      description: "When the token was revoked, null if still active",
    },
  },
});
