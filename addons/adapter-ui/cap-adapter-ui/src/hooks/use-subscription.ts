/**
 * Subscription hooks — SSE-based realtime event delivery.
 *
 * Two subscription modes:
 * 1. `useSubscription` — Low-level GraphQL subscription via graphql-yoga SSE transport
 * 2. `useEntitySubscription` — High-level entity-level subscription via /api/subscribe SSE endpoint (spec 44)
 *
 * Both support automatic reconnection with exponential backoff.
 */

import { createParser } from "eventsource-parser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toPascalCase } from "../lib/entity-api";

// ═══════════════════════════════════════════════════════════════
// GraphQL Subscription (existing — unchanged)
// ═══════════════════════════════════════════════════════════════

export interface UseSubscriptionOptions {
  /** GraphQL subscription query string */
  query: string;
  /** GraphQL variables */
  variables?: Record<string, unknown>;
  /** Callback when a subscription event is received */
  onData?: (data: unknown) => void;
  /** Whether the subscription is enabled (default: true) */
  enabled?: boolean;
}

export interface UseSubscriptionResult {
  /** Whether the SSE connection is currently active */
  connected: boolean;
  /** The last error that occurred, if any */
  error: string | null;
}

/** Max reconnection delay in ms */
const MAX_RECONNECT_DELAY = 30_000;
/** Initial reconnection delay in ms */
const INITIAL_RECONNECT_DELAY = 1_000;

/**
 * Subscribe to a GraphQL subscription via SSE (graphql-yoga protocol).
 *
 * graphql-yoga serves subscriptions over SSE on the same /graphql endpoint.
 * The client sends a GET request with the query encoded in the URL.
 */
export function useSubscription(options: UseSubscriptionOptions): UseSubscriptionResult {
  const { query, variables, onData, enabled = true } = options;

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable ref for onData to avoid reconnections when callback changes
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  // Serialize variables to a stable string to avoid reconnections on object reference changes
  const _variablesKey = useMemo(() => (variables ? JSON.stringify(variables) : ""), [variables]);
  // Keep a ref to variables so the effect closure always has the latest value
  const variablesRef = useRef(variables);
  variablesRef.current = variables;

  // Ref to track reconnect attempts for exponential backoff
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      setError(null);
      return;
    }

    let aborted = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const connect = async () => {
      if (aborted) return;

      try {
        // Build the SSE URL for graphql-yoga subscription
        const params = new URLSearchParams({
          query,
        });
        const vars = variablesRef.current;
        if (vars && Object.keys(vars).length > 0) {
          params.set("variables", JSON.stringify(vars));
        }

        const url = `/graphql?${params.toString()}`;

        // Add auth token if available
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
        };
        const token = localStorage.getItem("linchkit:token");
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(url, {
          method: "GET",
          headers,
        });

        if (aborted) return;

        if (!response.ok) {
          throw new Error(`Subscription connection failed: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("No response body for SSE stream");
        }

        setConnected(true);
        setError(null);
        reconnectAttemptRef.current = 0;

        // Read the SSE stream — frame parsing delegated to eventsource-parser
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let completed = false;

        const parser = createParser({
          onEvent(event) {
            if (event.event === "complete") {
              // Server signaled completion (graphql-yoga SSE protocol)
              completed = true;
              return;
            }
            if (!event.data) return;
            try {
              const parsed = JSON.parse(event.data);
              if (parsed.data && onDataRef.current) {
                onDataRef.current(parsed.data);
              }
            } catch {
              // Ignore malformed JSON
            }
          },
        });

        while (!aborted && !completed) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (aborted) return;

        const message = err instanceof Error ? err.message : "Subscription error";
        setError(message);
        setConnected(false);

        // Schedule reconnection with exponential backoff
        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(INITIAL_RECONNECT_DELAY * 2 ** attempt, MAX_RECONNECT_DELAY);

        reconnectTimerRef.current = setTimeout(() => {
          if (!aborted) connect();
        }, delay);
      }
    };

    connect();

    return () => {
      aborted = true;
      cleanup();
      if (reader) {
        reader.cancel().catch(() => {});
      }
      setConnected(false);
    };
  }, [query, enabled, cleanup]);

  return { connected, error };
}

// ── Convenience: entity record change subscription ─────

/**
 * Build a GraphQL subscription query for entity record changes.
 *
 * Subscribes to created, updated, and deleted events for a given entity.
 * The subscription field names follow the pattern: on{PascalName}Created, etc.
 * The server generates those field names in
 * addons/adapter-server/cap-adapter-server/src/graphql/build-subscriptions.ts —
 * both sides must derive the identical PascalCase name (see toPascalCase).
 */
export function buildEntitySubscriptionQuery(entityName: string): string {
  const pascal = toPascalCase(entityName);

  // Subscribe to all three event types using GraphQL subscription aliases
  return `
    subscription {
      created: on${pascal}Created { id }
      updated: on${pascal}Updated { id }
      deleted: on${pascal}Deleted { id }
    }
  `;
}

// ═══════════════════════════════════════════════════════════════
// Entity-level Subscription (spec 44 — /api/subscribe SSE)
// ═══════════════════════════════════════════════════════════════

/** SubscriptionEvent type received from /api/subscribe SSE endpoint */
export interface SubscriptionEvent {
  type:
    | "record.created"
    | "record.updated"
    | "record.deleted"
    | "state.changed"
    | "approval.resolved"
    | "entity.changed";
  schema: string;
  recordId: string;
  tenantId?: string;
  changes?: Record<string, unknown>;
  state?: { from: string; to: string; action: string };
  actor: { id: string; type: string };
  timestamp: string;
  executionId?: string;
}

/** @deprecated Use buildEntitySubscriptionQuery instead */
export const buildSchemaSubscriptionQuery = buildEntitySubscriptionQuery;

export interface UseEntitySubscriptionOptions {
  /** Entity names to subscribe to (empty array = all accessible entities) */
  entities: string[];
  /** Optional record IDs for fine-grained filtering */
  ids?: string[];
  /** Callback when a subscription event is received */
  onEvent?: (event: SubscriptionEvent) => void;
  /** Whether the subscription is enabled (default: true) */
  enabled?: boolean;
}

/** @deprecated Use UseEntitySubscriptionOptions instead */
export type UseSchemaSubscriptionOptions = UseEntitySubscriptionOptions;

export interface UseEntitySubscriptionResult {
  /** Whether the SSE connection is currently active */
  connected: boolean;
  /** The last error that occurred, if any */
  error: string | null;
  /** Connection ID assigned by the server */
  connectionId: string | null;
}

/**
 * Subscribe to entity record changes via the /api/subscribe SSE endpoint.
 *
 * This is the spec 44 compliant hook that:
 * - Connects to GET /api/subscribe?entities=...&ids=...
 * - Receives SubscriptionEvent payloads
 * - Auto-reconnects with exponential backoff
 * - Handles heartbeat keepalive messages
 */
/** @deprecated Use UseEntitySubscriptionResult instead */
export type UseSchemaSubscriptionResult = UseEntitySubscriptionResult;

export function useEntitySubscription(
  options: UseEntitySubscriptionOptions,
): UseEntitySubscriptionResult {
  const { entities, ids, onEvent, enabled = true } = options;

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Stable keys to avoid unnecessary reconnections
  const entitiesKey = useMemo(() => [...entities].sort().join(","), [entities]);
  const idsKey = useMemo(() => (ids ? ids.sort().join(",") : ""), [ids]);

  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Track last received event ID for reconnection replay */
  const lastEventIdRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      setError(null);
      setConnectionId(null);
      return;
    }

    let aborted = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const connect = async () => {
      if (aborted) return;

      try {
        // Build the SSE URL
        const params = new URLSearchParams();
        if (entitiesKey) params.set("entities", entitiesKey);
        if (idsKey) params.set("ids", idsKey);

        // Send last event ID for reconnection replay
        if (lastEventIdRef.current) {
          params.set("lastEventId", lastEventIdRef.current);
        }

        const url = `/api/subscribe?${params.toString()}`;

        const headers: Record<string, string> = {
          Accept: "text/event-stream",
        };
        const token = localStorage.getItem("linchkit:token");
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(url, { method: "GET", headers });

        if (aborted) return;

        if (!response.ok) {
          throw new Error(`Subscription connection failed: ${response.status}`);
        }

        if (!response.body) {
          throw new Error("No response body for SSE stream");
        }

        reconnectAttemptRef.current = 0;

        // Read the SSE stream — frame parsing delegated to eventsource-parser
        // (SSE comments such as keepalives are skipped by the parser itself)
        reader = response.body.getReader();
        const decoder = new TextDecoder();

        const parser = createParser({
          onEvent(event) {
            // Track last event ID for reconnection replay BEFORE the data
            // check — per the SSE spec the id buffer advances even on
            // data-less events (e.g. id-only heartbeats).
            if (event.id) {
              lastEventIdRef.current = event.id;
            }
            if (!event.data) return;

            try {
              const parsed = JSON.parse(event.data);

              if (event.event === "connected") {
                setConnected(true);
                setError(null);
                setConnectionId(parsed.connectionId ?? null);
              } else if (event.event === "error") {
                setError(parsed.error ?? "Subscription error");
              } else if (onEventRef.current) {
                // Deliver the subscription event
                onEventRef.current(parsed as SubscriptionEvent);
              }
            } catch {
              // Ignore malformed JSON
            }
          },
        });

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done || aborted) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (aborted) return;

        const message = err instanceof Error ? err.message : "Subscription error";
        setError(message);
        setConnected(false);
        setConnectionId(null);

        // Reconnect with exponential backoff
        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(INITIAL_RECONNECT_DELAY * 2 ** attempt, MAX_RECONNECT_DELAY);

        reconnectTimerRef.current = setTimeout(() => {
          if (!aborted) connect();
        }, delay);
      }
    };

    connect();

    return () => {
      aborted = true;
      cleanup();
      if (reader) {
        reader.cancel().catch(() => {});
      }
      setConnected(false);
      setConnectionId(null);
    };
  }, [entitiesKey, idsKey, enabled, cleanup]);

  return { connected, error, connectionId };
}

/** @deprecated Use useEntitySubscription instead */
export const useSchemaSubscription = useEntitySubscription;
