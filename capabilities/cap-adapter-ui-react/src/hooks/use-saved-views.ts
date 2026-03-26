/**
 * useSavedViews — Client-side saved view management backed by localStorage.
 *
 * Key: `linchkit:saved-views:${schemaName}`
 * Value: array of SavedView objects.
 *
 * Server-side persistence (DB table) can replace this later without changing
 * the public hook API.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

export interface SavedViewSort {
  field: string;
  order: "asc" | "desc";
}

export interface SavedViewFilter {
  field: string;
  operator: string;
  values: unknown[];
}

export interface SavedView {
  id: string;
  name: string;
  filters: SavedViewFilter[];
  sort?: SavedViewSort;
  columns?: string[];
  createdAt: string;
}

// ── localStorage helpers ─────────────────────────────────────────

function storageKey(schemaName: string): string {
  return `linchkit:saved-views:${schemaName}`;
}

function readViews(schemaName: string): SavedView[] {
  try {
    const raw = localStorage.getItem(storageKey(schemaName));
    if (!raw) return [];
    return JSON.parse(raw) as SavedView[];
  } catch {
    return [];
  }
}

function writeViews(schemaName: string, views: SavedView[]): void {
  localStorage.setItem(storageKey(schemaName), JSON.stringify(views));
  // Notify subscribers via a custom storage event (same-tab)
  window.dispatchEvent(new CustomEvent("linchkit:saved-views-change", { detail: schemaName }));
}

function generateId(): string {
  return `sv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── External store for useSyncExternalStore ──────────────────────

function subscribeToViews(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener("linchkit:saved-views-change", handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("linchkit:saved-views-change", handler);
    window.removeEventListener("storage", handler);
  };
}

// ── Public hook ──────────────────────────────────────────────────

export function useSavedViews(schemaName: string) {
  const getSnapshot = useCallback(() => {
    return localStorage.getItem(storageKey(schemaName)) ?? "[]";
  }, [schemaName]);

  const raw = useSyncExternalStore(subscribeToViews, getSnapshot, () => "[]");
  const views = useMemo<SavedView[]>(() => {
    try {
      return JSON.parse(raw) as SavedView[];
    } catch {
      return [];
    }
  }, [raw]);

  const createView = useCallback(
    (name: string, filters: SavedViewFilter[], sort?: SavedViewSort, columns?: string[]): SavedView => {
      const view: SavedView = {
        id: generateId(),
        name,
        filters,
        sort,
        columns,
        createdAt: new Date().toISOString(),
      };
      const current = readViews(schemaName);
      writeViews(schemaName, [...current, view]);
      return view;
    },
    [schemaName],
  );

  const renameView = useCallback(
    (viewId: string, newName: string): void => {
      const current = readViews(schemaName);
      const updated = current.map((v) => (v.id === viewId ? { ...v, name: newName } : v));
      writeViews(schemaName, updated);
    },
    [schemaName],
  );

  const deleteView = useCallback(
    (viewId: string): void => {
      const current = readViews(schemaName);
      writeViews(schemaName, current.filter((v) => v.id !== viewId));
    },
    [schemaName],
  );

  const updateView = useCallback(
    (viewId: string, filters: SavedViewFilter[], sort?: SavedViewSort): void => {
      const current = readViews(schemaName);
      const updated = current.map((v) =>
        v.id === viewId ? { ...v, filters, sort } : v,
      );
      writeViews(schemaName, updated);
    },
    [schemaName],
  );

  return { views, createView, renameView, deleteView, updateView };
}
