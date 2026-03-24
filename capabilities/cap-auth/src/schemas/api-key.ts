/**
 * API Key schema definition
 *
 * API keys provide non-interactive authentication for integrations,
 * scripts, and external systems. Per spec 10a_authentication.md ApiKeyRecord.
 */

import { defineSchema } from "@linchkit/core";

export const apiKeySchema = defineSchema({
  name: "api_key",
  label: "API Key",
  description: "API key for programmatic access",
  fields: {
    name: {
      type: "string",
      label: "Key Name",
      required: true,
      description: "Human-readable identifier for this key",
    },
    key_hash: {
      type: "string",
      label: "Key Hash",
      required: true,
      sensitive: true,
      secret: true,
      description: "SHA-256 hash of the API key",
    },
    key_prefix: {
      type: "string",
      label: "Key Prefix",
      required: true,
      description: "First 8 chars of the key for identification (e.g. lk_abc123)",
    },
    user_id: {
      type: "string",
      label: "Owner",
      required: true,
      description: "Foreign key to user (relationship managed via defineLink)",
    },
    tenant_id: {
      type: "string",
      label: "Tenant",
      required: true,
      description: "Tenant this API key is bound to",
    },
    scopes: {
      type: "json",
      label: "Scopes",
      description: "Allowed action scopes for this key",
      default: [],
    },
    expires_at: {
      type: "datetime",
      label: "Expires At",
    },
    last_used_at: {
      type: "datetime",
      label: "Last Used At",
    },
    is_active: {
      type: "boolean",
      label: "Active",
      default: true,
    },
    revoked_at: {
      type: "datetime",
      label: "Revoked At",
      description: "When the key was revoked, for audit trail",
    },
  },
  presentation: {
    titleField: "name",
    subtitleField: "key_prefix",
    summaryFields: ["name", "key_prefix", "is_active", "last_used_at"],
    icon: "key",
  },
});
