/**
 * useOverlayFields — Fetches runtime overlay field definitions for an entity.
 *
 * Overlay fields are dynamic fields added at runtime via the Entity Overlay system.
 * Their metadata is fetched from GET /api/overlays/:entityName and cached per entity.
 * Field data lives in the record's `_extensions` JSONB column.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FieldOverlayRecord } from "../lib/overlay-types";

/** In-memory cache keyed by entity name */
const overlayCache = new Map<string, FieldOverlayRecord[]>();

/**
 * Fetch overlay fields from the REST API.
 * Returns empty array on failure (graceful degradation when overlay system is not installed).
 */
async function fetchOverlayFields(entityName: string): Promise<FieldOverlayRecord[]> {
  try {
    const res = await fetch(`/api/overlays/${encodeURIComponent(entityName)}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.data ?? [];
  } catch {
    return [];
  }
}

export interface UseOverlayFieldsResult {
  overlayFields: FieldOverlayRecord[];
  loading: boolean;
  refresh: () => void;
}

/**
 * Hook to fetch and cache overlay fields for a given entity.
 * Returns an empty array when entityName is falsy or when the overlay API is unavailable.
 */
export function useOverlayFields(entityName: string | undefined): UseOverlayFieldsResult {
  const [overlayFields, setOverlayFields] = useState<FieldOverlayRecord[]>(() => {
    if (!entityName) return [];
    return overlayCache.get(entityName) ?? [];
  });
  const [loading, setLoading] = useState(() => {
    if (!entityName) return false;
    return !overlayCache.has(entityName);
  });
  const entityNameRef = useRef(entityName);
  entityNameRef.current = entityName;

  const load = useCallback(async () => {
    const name = entityNameRef.current;
    if (!name) {
      setOverlayFields([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const fields = await fetchOverlayFields(name);
    overlayCache.set(name, fields);
    // Only update state if entity name hasn't changed during fetch
    if (entityNameRef.current === name) {
      setOverlayFields(fields);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!entityName) {
      setOverlayFields([]);
      setLoading(false);
      return;
    }
    const cached = overlayCache.get(entityName);
    if (cached) {
      setOverlayFields(cached);
      setLoading(false);
    } else {
      load();
    }
  }, [entityName, load]);

  const refresh = useCallback(() => {
    if (entityName) {
      overlayCache.delete(entityName);
    }
    load();
  }, [entityName, load]);

  return { overlayFields, loading, refresh };
}

/**
 * Clear overlay cache for a specific entity (e.g. after adding/removing overlay fields).
 * Call without arguments to clear all cached entries.
 */
export function clearOverlayCache(entityName?: string): void {
  if (entityName) {
    overlayCache.delete(entityName);
  } else {
    overlayCache.clear();
  }
}
