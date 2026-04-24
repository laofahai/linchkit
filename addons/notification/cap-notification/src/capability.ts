/**
 * cap-notification capability definition
 *
 * Multi-channel notification dispatch. Ships with an in-app channel that
 * persists to the `notification` entity; email and webhook channels are stubs
 * reserved for follow-up work.
 */

import { defineCapability } from "@linchkit/core";
import { markAllReadAction } from "./actions/mark_all_read";
import { markNotificationReadAction } from "./actions/mark_notification_read";
import { sendNotificationAction } from "./actions/send_notification";
import { notificationSchema } from "./entities/notification";

export const capNotification = defineCapability({
  name: "cap-notification",
  label: "Notification Center",
  description: "Multi-channel notification dispatch with in-app channel built in",
  type: "standard",
  category: "system",
  version: "0.0.1",

  entities: [notificationSchema],
  actions: [sendNotificationAction, markNotificationReadAction, markAllReadAction],

  systemPermissions: ["database.read", "database.write", "event.emit"],
});
