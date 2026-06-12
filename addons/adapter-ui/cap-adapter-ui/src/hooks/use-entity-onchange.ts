/**
 * useEntityOnchange — Front-end glue for Spec 64 entity onchange.
 *
 * Thin React wrapper around `OnchangeDispatcher`. Handles the dispatcher
 * lifecycle (mount / unmount / re-index on schema change) and exposes
 * loading + pending-fields state for the UI.
 */

import type { OnchangeDefinition } from "@linchkit/core/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestEntityOnchange } from "../lib/entity-api";
import {
  DEFAULT_ONCHANGE_DEBOUNCE_MS,
  OnchangeDispatcher,
  type OnchangeFetcher,
} from "../lib/onchange-dispatcher";

export { DEFAULT_ONCHANGE_DEBOUNCE_MS } from "../lib/onchange-dispatcher";

export interface UseEntityOnchangeOptions {
  /** Entity name (`schema.name`). When undefined the hook is a no-op. */
  entity: string | undefined;
  /** Onchange map from the entity definition. */
  onchange: Record<string, OnchangeDefinition> | undefined;
  /** Returns the current form values at call time. */
  getValues: () => Record<string, unknown>;
  /** Apply server-returned `updates` to form state. */
  applyUpdates: (updates: Record<string, unknown>) => void;
  /** Optional non-blocking warnings handler. */
  onWarnings?: (warnings: string[]) => void;
  /** Per-call debounce override. Falls back to {@link DEFAULT_ONCHANGE_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Test-only fetcher injection. */
  fetcher?: OnchangeFetcher;
}

export interface UseEntityOnchangeReturn {
  loading: boolean;
  pendingFields: ReadonlySet<string>;
  trigger: (changedField: string) => void;
  cancel: () => void;
}

export function useEntityOnchange(options: UseEntityOnchangeOptions): UseEntityOnchangeReturn {
  const {
    entity,
    onchange,
    getValues,
    applyUpdates,
    onWarnings,
    debounceMs = DEFAULT_ONCHANGE_DEBOUNCE_MS,
    fetcher = requestEntityOnchange,
  } = options;

  // Ref-based callbacks so dispatcher captures fresh closures without re-init.
  const getValuesRef = useRef(getValues);
  const applyUpdatesRef = useRef(applyUpdates);
  const onWarningsRef = useRef(onWarnings);
  const fetcherRef = useRef(fetcher);
  getValuesRef.current = getValues;
  applyUpdatesRef.current = applyUpdates;
  onWarningsRef.current = onWarnings;
  fetcherRef.current = fetcher;

  const [loading, setLoading] = useState(false);
  const [pendingFields, setPendingFields] = useState<ReadonlySet<string>>(new Set());

  const dispatcherRef = useRef<OnchangeDispatcher | null>(null);

  // `onchange` is intentionally absent from this effect's deps: the
  // dispatcher exposes `setOnchange` (called from the next effect) so
  // identity churn on the onchange map doesn't tear down + rebuild the
  // dispatcher (which would cancel the current debounce + abort an
  // in-flight request). Captured-at-mount value is fine for the initial
  // construction; subsequent updates flow through `setOnchange`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!entity) {
      dispatcherRef.current?.cancel();
      dispatcherRef.current = null;
      return;
    }
    const dispatcher = new OnchangeDispatcher({
      entity,
      onchange,
      getValues: () => getValuesRef.current(),
      onUpdates: (updates) => applyUpdatesRef.current(updates),
      onWarnings: (warnings) => onWarningsRef.current?.(warnings),
      onLoadingChange: (l, p) => {
        setLoading(l);
        setPendingFields(p);
      },
      fetcher: (params) => fetcherRef.current(params),
      debounceMs,
    });
    dispatcherRef.current = dispatcher;
    return () => {
      dispatcher.cancel();
      if (dispatcherRef.current === dispatcher) dispatcherRef.current = null;
    };
  }, [entity, debounceMs]);

  // Re-index when the onchange map identity changes without recreating dispatcher.
  useEffect(() => {
    dispatcherRef.current?.setOnchange(onchange);
  }, [onchange]);

  const trigger = useCallback((changedField: string) => {
    dispatcherRef.current?.trigger(changedField);
  }, []);

  const cancel = useCallback(() => {
    dispatcherRef.current?.cancel();
  }, []);

  return { loading, pendingFields, trigger, cancel };
}
