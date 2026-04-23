/**
 * send_notification action
 *
 * Sole write entry for dispatching a notification. Routes the request to the
 * requested channel (default: in_app). The channel is responsible for the
 * actual persistence / transport; this action is the stable external contract.
 */

import { defineAction } from "@linchkit/core";
import type {
  NotificationChannel,
  NotificationChannelContext,
  NotificationChannelName,
  NotificationDispatchRequest,
  NotificationDispatchResult,
} from "../channels/channel";
import { EmailNotificationChannel } from "../channels/email";
import { createInAppChannel, type NotificationStore } from "../channels/in-app";
import { WebhookNotificationChannel } from "../channels/webhook";

const SUPPORTED_CHANNELS: readonly NotificationChannelName[] = ["in_app", "email", "webhook"];

function isChannelName(value: unknown): value is NotificationChannelName {
  return typeof value === "string" && (SUPPORTED_CHANNELS as readonly string[]).includes(value);
}

/**
 * Resolve a channel implementation from an ActionContext.
 *
 * The `in_app` channel is built directly from `ctx.create`; other channels
 * are stubs and return `{ delivered: false, reason }`. This keeps the action
 * self-contained so the capability can function without an explicit channel
 * registry while still allowing real implementations to be wired in later.
 */
function resolveChannel(
  name: NotificationChannelName,
  store: NotificationStore,
): NotificationChannel {
  switch (name) {
    case "in_app":
      return createInAppChannel({ store });
    case "email":
      return new EmailNotificationChannel();
    case "webhook":
      return new WebhookNotificationChannel();
    default: {
      // Exhaustiveness check — unreachable when SUPPORTED_CHANNELS is honored
      const exhaustive: never = name;
      throw new Error(`Unsupported notification channel: ${String(exhaustive)}`);
    }
  }
}

export const sendNotificationAction = defineAction({
  name: "send_notification",
  entity: "notification",
  label: "Send Notification",
  description: "Dispatch a notification to a recipient on the requested channel",
  input: {
    recipient_id: {
      type: "string",
      label: "Recipient",
      required: true,
    },
    channel: {
      type: "enum",
      label: "Channel",
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
    },
    message: {
      type: "text",
      label: "Message",
      required: true,
    },
    link: {
      type: "string",
      label: "Link",
    },
    metadata: {
      type: "json",
      label: "Metadata",
    },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: false,
  },
  // send_notification is a system-side dispatch primitive. It is declared with
  // the HTTP/UI/CLI/MCP exposures so system actors and AI agents can invoke it
  // over any transport, but the handler hard-gates human callers so business
  // users cannot spoof notifications to arbitrary recipients. Trigger this
  // action from a Rule, EventHandler, or another privileged action.
  exposure: { http: true, ui: true, cli: true, mcp: true },
  permissions: { actorTypes: ["system", "worker", "ai", "timer"] },
  async handler(ctx): Promise<NotificationDispatchResult> {
    // Defensive check — `permissions.actorTypes` is a hint in some code paths,
    // so also enforce in-handler to guarantee no human actor can dispatch.
    const actorType = ctx.actor.type;
    if (
      actorType !== "system" &&
      actorType !== "worker" &&
      actorType !== "ai" &&
      actorType !== "timer"
    ) {
      throw new Error(
        "send_notification is a system dispatch primitive — invoke it from a Rule, EventHandler, or another privileged action",
      );
    }

    const recipientId = ctx.input.recipient_id;
    const message = ctx.input.message;
    const rawChannel = ctx.input.channel ?? "in_app";
    const title = ctx.input.title;
    const link = ctx.input.link;
    const metadata = ctx.input.metadata;

    if (typeof recipientId !== "string" || !recipientId.trim()) {
      throw new Error("recipient_id is required");
    }
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("message is required");
    }
    if (!isChannelName(rawChannel)) {
      throw new Error(`Unsupported channel: ${String(rawChannel)}`);
    }

    const request: NotificationDispatchRequest = {
      recipientId,
      message,
      title: typeof title === "string" ? title : undefined,
      link: typeof link === "string" ? link : undefined,
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : undefined,
      tenantId: ctx.tenantId,
    };

    const channelContext: NotificationChannelContext = {
      actorId: ctx.actor.id,
      tenantId: ctx.tenantId,
    };

    const channel = resolveChannel(rawChannel, {
      create: (entity, data) => ctx.create(entity, data),
    });

    const result = await channel.send(request, channelContext);

    if (result.delivered) {
      ctx.emit("notification.sent", {
        recipient_id: recipientId,
        channel: result.channel,
        notification_id: result.id,
      });
    }

    return result;
  },
});
