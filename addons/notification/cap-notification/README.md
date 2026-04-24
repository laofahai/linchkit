# @linchkit/cap-notification

Notification center capability for LinchKit. Provides the `notification` entity,
three write actions (`send_notification`, `mark_notification_read`,
`mark_all_read`), and a pluggable `NotificationChannel` interface with a
built-in in-app channel. Email and webhook channels are stubs — wire in real
transports as follow-up work.

## Install

```ts
import { capNotification } from "@linchkit/cap-notification";

// Register alongside your other capabilities
export const capabilities = [
  // ...
  capNotification,
];
```

## Exports

| Export | Purpose |
| --- | --- |
| `capNotification` | Capability definition (register it with the core runtime). |
| `notificationSchema` | `defineEntity` output for `notification`. |
| `sendNotificationAction` | Dispatch a notification on the chosen channel. |
| `markNotificationReadAction` | Mark a single notification read. |
| `markAllReadAction` | Mark every unread notification for a recipient. |
| `NotificationChannel` (type) | Interface every channel implements. |
| `InAppNotificationChannel`, `createInAppChannel` | In-app channel (persists to the `notification` entity). |
| `EmailNotificationChannel`, `WebhookNotificationChannel` | Stubs — replace or subclass. |

## Channel contract

`NotificationChannel.send(request, context)` returns
`{ channel, delivered, id, reason? }`. Channels MUST NOT throw for expected
business failures (opted-out recipient, bad input) — return
`{ delivered: false, reason }` instead so the calling action can log and
continue.

## Follow-ups

- `cap-notification: implement email channel (SMTP/Resend/SES adapter)`
- `cap-notification: implement webhook channel (signed HTTP POST + retry + DLQ)`
- `cap-notification: add NotificationPreferences entity (opt-in/out per channel)`
- `cap-notification-ui: notification center panel + unread badge count`
- `cap-notification: batch dispatch action (send_bulk_notification)`
