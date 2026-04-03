/**
 * useSchemas — Fetches registered schemas from the server.
 *
 * Provides a list of available schemas for navigation and dynamic page rendering.
 * Falls back gracefully if the API is unavailable.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { fetchSchemas, type SchemaInfo } from "@/lib/api";

interface SchemasContextValue {
  schemas: SchemaInfo[];
  loading: boolean;
  refresh: () => void;
}

const SchemasContext = createContext<SchemasContextValue>({
  schemas: [],
  loading: true,
  refresh: () => {},
});

export function SchemasProvider({ children }: { children: React.ReactNode }) {
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchSchemas();
      setSchemas(data);
    } catch {
      // API unavailable — empty list, sidebar shows no schemas
      setSchemas([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <SchemasContext.Provider value={{ schemas, loading, refresh }}>
      {children}
    </SchemasContext.Provider>
  );
}

export function useEntities() {
  return useContext(SchemasContext);
}
