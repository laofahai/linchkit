/**
 * User schema definition
 *
 * Core user entity for authentication. Contains identity fields,
 * status (managed by user_lifecycle state machine), and group assignments.
 */

import { defineEntity } from "@linchkit/core";

export const userSchema = defineEntity({
  name: "user",
  label: "User",
  description: "System user account",
  fields: {
    email: {
      type: "string",
      label: "Email",
      required: true,
      unique: true,
      format: "email",
    },
    name: {
      type: "string",
      label: "Name",
      required: true,
    },
    password_hash: {
      type: "string",
      label: "Password Hash",
      sensitive: true,
      secret: true,
    },
    status: {
      type: "state",
      label: "Status",
      machine: "user_lifecycle",
    },
    groups: {
      type: "json",
      label: "Permission Groups",
      description: "Array of permission group names assigned to this user",
      default: [],
    },
    metadata: {
      type: "json",
      label: "Metadata",
      description: "Arbitrary user metadata (department, locale, etc.)",
    },
    last_login_at: {
      type: "datetime",
      label: "Last Login",
    },
  },
  presentation: {
    titleField: "name",
    subtitleField: "email",
    badgeField: "status",
    summaryFields: ["email", "status", "last_login_at"],
    icon: "user",
  },
});
