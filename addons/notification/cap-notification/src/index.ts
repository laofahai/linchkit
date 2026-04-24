/**
 * @linchkit/cap-notification — public exports.
 */

export { markAllReadAction } from "./actions/mark_all_read";
export { markNotificationReadAction } from "./actions/mark_notification_read";
export { sendNotificationAction } from "./actions/send_notification";
export { capNotification } from "./capability";
export type {
  NotificationChannel,
  NotificationChannelContext,
  NotificationChannelName,
  NotificationDispatchRequest,
  NotificationDispatchResult,
} from "./channels/channel";
export { EmailNotificationChannel } from "./channels/email";

export {
  createInAppChannel,
  type InAppChannelOptions,
  InAppNotificationChannel,
  type NotificationStore,
} from "./channels/in-app";
export { WebhookNotificationChannel } from "./channels/webhook";
export { notificationSchema } from "./entities/notification";
