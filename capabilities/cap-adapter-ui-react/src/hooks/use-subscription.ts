/**
 * useSubscription — SSE-based GraphQL subscription hook.
 *
 * Connects to graphql-yoga's SSE subscription transport.
 * Handles automatic reconnection with exponential backoff.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const variablesKey = useMemo(
    () => (variables ? JSON.stringify(variables) : ""),
    [variables],
  );
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

        // Read the SSE stream
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done || aborted) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from the buffer
          const lines = buffer.split("\n");
          // Keep the last potentially incomplete line in the buffer
          buffer = lines.pop() ?? "";

          let eventData = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              eventData += line.slice(6);
            } else if (line.startsWith("event: complete")) {
              // Server signaled completion
              return;
            } else if (line === "" && eventData) {
              // Empty line = end of event, parse accumulated data
              try {
                const parsed = JSON.parse(eventData);
                if (parsed.data && onDataRef.current) {
                  onDataRef.current(parsed.data);
                }
              } catch {
                // Ignore malformed JSON
              }
              eventData = "";
            }
          }
        }
      } catch (err) {
        if (aborted) return;

        const message = err instanceof Error ? err.message : "Subscription error";
        setError(message);
        setConnected(false);

        // Schedule reconnection with exponential backoff
        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(
          INITIAL_RECONNECT_DELAY * 2 ** attempt,
          MAX_RECONNECT_DELAY,
        );

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
  }, [query, variablesKey, enabled, cleanup]);

  return { connected, error };
}

// ── Convenience: schema record change subscription ─────

/**
 * Build a GraphQL subscription query for schema record changes.
 *
 * Subscribes to created, updated, and deleted events for a given schema.
 * The subscription field names follow the pattern: on{PascalName}Created, etc.
 */
export function buildSchemaSubscriptionQuery(schemaName: string): string {
  const pascal = schemaName
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");

  // Subscribe to all three event types using GraphQL subscription aliases
  return `
    subscription {
      created: on${pascal}Created { id }
      updated: on${pascal}Updated { id }
      deleted: on${pascal}Deleted { id }
    }
  `;
}
