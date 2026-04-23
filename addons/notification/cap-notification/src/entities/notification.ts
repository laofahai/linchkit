/**
 * Notification entity definition
 *
 * Stores a single notification addressed to a recipient on a given channel.
 * System fields (id, tenant_id, created_at, updated_at, created_by, updated_by,
 * _version) are managed by the framework and are intentionally not declared here.
 *
 * Spec reference: docs/specs/14_system_capabilities.md section 4.4
 */

import { defineEntity } from "@linchkit/core";

export const notificationSchema = defineEntity({
  name: "notification",
  label: "Notification",
  description: "A single notification addressed to a recipient on a given channel",
  fields: {
    recipient_id: {
      type: "string",
      label: "Recipient",
      required: true,
      description: "User (or actor) who should receive this notification",
    },
    channel: {
      type: "enum",
      label: "Channel",
      required: true,
      description: "Dispatch channel name (in_app is the only implemented channel for now)",
      options: [
        { value: "in_app", label: "In-App" },
        { value: "email", label: "Email" },
        { value: "webhook", label: "Webhook" },
      ],
      default: "in_app",
    },
    title: {
      type: "string",
      label: "Title",
      description: "Optional short headline shown in notification center",
    },
    message: {
      type: "text",
      label: "Message",
      required: true,
      description: "Human-readable notification body",
    },
    link: {
      type: "string",
      label: "Link",
      description: "Optional deep link for the UI to navigate to on click",
    },
    metadata: {
      type: "json",
      label: "Metadata",
      description: "Free-form structured payload (entity/record references, counters, etc.)",
    },
    read_at: {
      type: "datetime",
      label: "Read At",
      description: "Timestamp the recipient marked this notification read. Null = unread.",
    },
  },
  presentation: {
    titleField: "title",
    subtitleField: "message",
    summaryFields: ["recipient_id", "channel", "read_at"],
    icon: "bell",
  },
});
