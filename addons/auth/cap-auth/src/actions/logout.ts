/**
 * Logout action
 *
 * Invalidates the current session and revokes the access token.
 */

import { defineAction } from "@linchkit/core";

export const logoutAction = defineAction({
  name: "logout",
  entity: "session",
  label: "Logout",
  description: "Invalidate current session",
  input: {
    session_id: {
      type: "string",
      label: "Session ID",
      description: "If omitted, invalidates the current session from context",
    },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: true,
  },
  exposure: "all",
  // No handler — provided by AuthProvider implementation (e.g. cap-auth-better-auth)
});
