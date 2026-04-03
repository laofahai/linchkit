/**
 * Session schema definition
 *
 * Tracks active user sessions. Each login creates a session record
 * that is validated on subsequent requests.
 */

import { defineSchema } from "@linchkit/core";

export const sessionSchema = defineSchema({
  name: "session",
  label: "Session",
  description: "Active user session",
  fields: {
    user_id: {
      type: "string",
      label: "User",
      required: true,
      description: "Foreign key to user (relationship managed via defineLink)",
    },
    token_hash: {
      type: "string",
      label: "Token Hash",
      required: true,
      sensitive: true,
      secret: true,
    },
    expires_at: {
      type: "datetime",
      label: "Expires At",
      required: true,
    },
    ip_address: {
      type: "string",
      label: "IP Address",
    },
    user_agent: {
      type: "string",
      label: "User Agent",
    },
    is_active: {
      type: "boolean",
      label: "Active",
      default: true,
    },
  },
});
