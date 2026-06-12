/**
 * useEntityBundle — Fetches and caches entity bundles (entity + views).
 *
 * Uses a React context to cache fetched bundles by entity name.
 * Once an entity is loaded, subsequent navigations serve from cache.
 */

import type {
  EntityDefinition,
  RelationDefinition,
  StateDefinition,
  ViewDefinition,
} from "@linchkit/core/types";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { fetchEntityBundle } from "@/lib/entity-api";

export interface ResolvedEntityBundle {
  schema: EntityDefinition;
  views: Record<string, ViewDefinition>;
  states?: StateDefinition[];
  relations?: RelationDefinition[];
  /** True for system-internal entities (read-only, managed by core) */
  internal?: boolean;
}

function normalizeViews(rawViews: unknown): Record<string, ViewDefinition> {
  if (!rawViews) return {};

  if (Array.isArray(rawViews)) {
    return rawViews.reduce<Record<string, ViewDefinition>>((acc, view) => {
      if (view && typeof view === "object" && "name" in view) {
        const typedView = view as ViewDefinition;
        acc[typedView.name] = typedView;
      }
      return acc;
    }, {});
  }

  if (typeof rawViews !== "object") return {};

  return Object.entries(rawViews as Record<string, unknown>).reduce<Record<string, ViewDefinition>>(
    (acc, [key, view]) => {
      if (!view || typeof view !== "object") return acc;
      const typedView = view as ViewDefinition;
      const viewName = typedView.name ?? key;
      acc[viewName] = typedView;
      return acc;
    },
    {},
  );
}

interface EntityBundleCacheContextValue {
  getBundle: (name: string) => ResolvedEntityBundle | undefined;
  fetchBundle: (name: string) => Promise<ResolvedEntityBundle | null>;
}

const EntityBundleCacheContext = createContext<EntityBundleCacheContextValue>({
  getBundle: () => undefined,
  fetchBundle: async () => null,
});

export function EntityBundleCacheProvider({ children }: { children: React.ReactNode }) {
  const cacheRef = useRef<Map<string, ResolvedEntityBundle>>(new Map());

  const getBundle = useCallback((name: string) => {
    return cacheRef.current.get(name);
  }, []);

  const fetchBundleFn = useCallback(async (name: string): Promise<ResolvedEntityBundle | null> => {
    // Return from cache if available
    const cached = cacheRef.current.get(name);
    if (cached) return cached;

    const raw = await fetchEntityBundle(name);
    if (!raw) return null;

    const bundle: ResolvedEntityBundle = {
      schema: {
        name: raw.name,
        label: raw.label,
        description: raw.description,
        fields: raw.fields,
        presentation: raw.presentation,
      } as EntityDefinition,
      views: normalizeViews(raw.views),
      states: raw.states,
      relations: raw.relations,
      internal: raw.internal,
    };

    cacheRef.current.set(name, bundle);
    return bundle;
  }, []);

  return (
    <EntityBundleCacheContext.Provider value={{ getBundle, fetchBundle: fetchBundleFn }}>
      {children}
    </EntityBundleCacheContext.Provider>
  );
}

/**
 * Hook to fetch a schema bundle by name.
 * Returns loading state, bundle data, and error state.
 */
export function useEntityBundle(name: string) {
  const { getBundle, fetchBundle } = useContext(EntityBundleCacheContext);
  const [bundle, setBundle] = useState<ResolvedEntityBundle | undefined>(() => getBundle(name));
  const [loading, setLoading] = useState(!getBundle(name));
  const [error, setError] = useState(false);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(false);
    try {
      const result = await fetchBundle(name);
      if (requestId !== requestIdRef.current) return;

      if (result) {
        setBundle(result);
      } else {
        setBundle(undefined);
        setError(true);
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setBundle(undefined);
      setError(true);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [name, fetchBundle]);

  useEffect(() => {
    // Guard: skip fetch when name is empty (e.g. during initial render before schema name is known)
    if (!name) {
      setBundle(undefined);
      setLoading(false);
      setError(false);
      return;
    }

    const cached = getBundle(name);
    setBundle(cached);
    setError(false);

    if (!cached) {
      load();
    } else {
      setLoading(false);
    }
  }, [name, getBundle, load]);

  return { bundle, loading, error, reload: load };
}
