/**
 * useTransitionPermissions — Fetches available transitions and builds permission map.
 *
 * Used by SchemaFormPage to disable business action buttons
 * when the actor lacks permission or the transition is invalid.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { type AvailableTransition, queryAvailableTransitions } from "../lib/api";

export interface TransitionPermission {
  allowed: boolean;
  reason?: string | null;
}

export function useTransitionPermissions(
  entityName: string | undefined,
  recordId: string | undefined,
  enabled: boolean,
) {
  const [transitions, setTransitions] = useState<AvailableTransition[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!entityName || !recordId || !enabled) return;
    setLoading(true);
    try {
      const result = await queryAvailableTransitions(entityName, recordId);
      setTransitions(result);
    } catch {
      setTransitions([]);
    } finally {
      setLoading(false);
    }
  }, [entityName, recordId, enabled]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Map: action name → { allowed, reason }
  const permMap = useMemo(() => {
    const map = new Map<string, TransitionPermission>();
    for (const tr of transitions) {
      map.set(tr.action, { allowed: tr.allowed, reason: tr.reason });
    }
    return map;
  }, [transitions]);

  return { transitions, permMap, loading, refetch: fetch };
}
