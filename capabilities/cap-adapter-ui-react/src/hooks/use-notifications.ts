/**
 * useNotifications — In-memory notification store with SSE integration.
 *
 * Stores up to MAX_NOTIFICATIONS items in memory (FIFO).
 * Listens to SSE subscription events and action execution results.
 */

import { useCallback, useSyncExternalStore } from "react";

// ── Types ─────────────────────────────────────────────────

export type NotificationType = "created" | "updated" | "deleted" | "action_success" | "action_failure";

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  /** Schema name, if applicable */
  schema?: string;
  /** Record id, if applicable */
  recordId?: string;
  timestamp: number;
  read: boolean;
}

// ── Store (singleton, external to React) ──────────────────

const MAX_NOTIFICATIONS = 50;

let notifications: Notification[] = [];
let listeners = new Set<() => void>();
let nextId = 1;

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): Notification[] {
  return notifications;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Public API ────────────────────────────────────────────

export function pushNotification(n: Omit<Notification, "id" | "timestamp" | "read">) {
  const entry: Notification = {
    ...n,
    id: String(nextId++),
    timestamp: Date.now(),
    read: false,
  };
  // Prepend and cap at MAX
  notifications = [entry, ...notifications].slice(0, MAX_NOTIFICATIONS);
  emitChange();
}

export function markAllRead() {
  if (notifications.some((n) => !n.read)) {
    notifications = notifications.map((n) => (n.read ? n : { ...n, read: true }));
    emitChange();
  }
}

export function clearNotifications() {
  if (notifications.length > 0) {
    notifications = [];
    emitChange();
  }
}

// ── Hook ──────────────────────────────────────────────────

export function useNotifications() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const unreadCount = items.filter((n) => !n.read).length;

  return {
    notifications: items,
    unreadCount,
    push: useCallback(pushNotification, []),
    markAllRead: useCallback(markAllRead, []),
    clear: useCallback(clearNotifications, []),
  };
}
