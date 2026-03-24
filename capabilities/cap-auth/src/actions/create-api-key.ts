/**
 * Create API Key action
 *
 * Generates a new API key for programmatic access.
 * The raw key is only returned once at creation time.
 */

import { defineAction } from "@linchkit/core";

export const createApiKeyAction = defineAction({
  name: "create_api_key",
  schema: "api_key",
  label: "Create API Key",
  description: "Generate a new API key for programmatic access",
  input: {
    name: {
      type: "string",
      label: "Key Name",
      required: true,
    },
    scopes: {
      type: "json",
      label: "Scopes",
      description: "Allowed action scopes",
    },
    expires_at: {
      type: "datetime",
      label: "Expiration",
    },
  },
  output: {
    key: {
      type: "string",
      label: "API Key",
      sensitive: true,
      description: "The raw API key — only shown once",
    },
    key_prefix: { type: "string", label: "Key Prefix" },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: false,
  },
  exposure: { http: true, ui: true, mcp: false, cli: true },
  // No handler — provided by AuthProvider implementation (e.g. cap-auth-better-auth)
});
