/**
 * useEntities — Fetches registered entities from the server.
 *
 * Provides a list of available entities for navigation and dynamic page rendering.
 * Falls back gracefully if the API is unavailable.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { type EntityInfo, fetchEntities } from "@/lib/entity-meta";

interface EntitiesContextValue {
  entities: EntityInfo[];
  loading: boolean;
  refresh: () => void;
}

const EntitiesContext = createContext<EntitiesContextValue>({
  entities: [],
  loading: true,
  refresh: () => {},
});

export function EntitiesProvider({ children }: { children: React.ReactNode }) {
  const [entities, setEntities] = useState<EntityInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchEntities();
      setEntities(data);
    } catch {
      // API unavailable — empty list, sidebar shows no entities
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <EntitiesContext.Provider value={{ entities, loading, refresh }}>
      {children}
    </EntitiesContext.Provider>
  );
}

export function useEntities() {
  return useContext(EntitiesContext);
}
