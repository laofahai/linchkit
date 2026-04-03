/**
 * NotificationCenter — Bell icon with popover dropdown showing recent notifications.
 *
 * Displays unread badge, notification list with icons and relative timestamps,
 * and a "mark all as read" action.
 */

import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import {
  BellIcon,
  CheckCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  PencilIcon,
  PlusCircleIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Notification, NotificationType } from "@/hooks/use-notifications";
import { useNotifications } from "@/hooks/use-notifications";

// ── Icon mapping ──────────────────────────────────────────

const iconMap: Record<NotificationType, React.ElementType> = {
  created: PlusCircleIcon,
  updated: PencilIcon,
  deleted: Trash2Icon,
  action_success: CircleCheckIcon,
  action_failure: CircleAlertIcon,
};

const iconColorMap: Record<NotificationType, string> = {
  created: "text-green-500",
  updated: "text-blue-500",
  deleted: "text-red-500",
  action_success: "text-green-500",
  action_failure: "text-destructive",
};

// ── Relative time ─────────────────────────────────────────

function useRelativeTime() {
  const { t } = useTranslation();

  return (timestamp: number): string => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return t("time.justNow");
    if (minutes < 60) return t("time.minutesAgo", { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("time.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    return t("time.daysAgo", { count: days });
  };
}

// ── NotificationItem ──────────────────────────────────────

function NotificationItem({
  notification,
  formatTime,
}: {
  notification: Notification;
  formatTime: (ts: number) => string;
}) {
  const Icon = iconMap[notification.type] ?? ZapIcon;
  const colorClass = iconColorMap[notification.type] ?? "text-muted-foreground";

  return (
    <div
      className={`flex items-start gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors ${
        notification.read ? "opacity-60" : ""
      }`}
    >
      <div className={`mt-0.5 shrink-0 ${colorClass}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug break-words">{notification.message}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{formatTime(notification.timestamp)}</p>
      </div>
    </div>
  );
}

// ── NotificationCenter ────────────────────────────────────

export function NotificationCenter() {
  const { notifications, unreadCount, markAllRead } = useNotifications();
  const { t } = useTranslation();
  const formatTime = useRelativeTime();

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="relative text-muted-foreground">
              <BellIcon className="size-4" />
              {unreadCount > 0 && (
                <Badge
                  variant="destructive"
                  className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] leading-none"
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("notifications.title")}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-80 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2">
          <h4 className="text-sm font-semibold">{t("notifications.title")}</h4>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={markAllRead}
            >
              <CheckCheckIcon className="size-3.5" />
              {t("notifications.markAllRead")}
            </Button>
          )}
        </div>
        <Separator />

        {/* Notification list */}
        <div className="max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <BellIcon className="mb-2 size-8 opacity-30" />
              <p className="text-sm">{t("notifications.empty")}</p>
            </div>
          ) : (
            notifications.map((n) => (
              <NotificationItem key={n.id} notification={n} formatTime={formatTime} />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
