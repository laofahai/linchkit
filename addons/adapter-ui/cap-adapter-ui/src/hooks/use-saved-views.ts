/**
 * useSavedViews — Client-side saved view management backed by localStorage.
 *
 * Key: `linchkit:saved-views:${entityName}`
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

function storageKey(entityName: string): string {
  return `linchkit:saved-views:${entityName}`;
}

function readViews(entityName: string): SavedView[] {
  try {
    const raw = localStorage.getItem(storageKey(entityName));
    if (!raw) return [];
    return JSON.parse(raw) as SavedView[];
  } catch {
    return [];
  }
}

function writeViews(entityName: string, views: SavedView[]): void {
  localStorage.setItem(storageKey(entityName), JSON.stringify(views));
  // Notify subscribers via a custom storage event (same-tab)
  window.dispatchEvent(new CustomEvent("linchkit:saved-views-change", { detail: entityName }));
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

export function useSavedViews(entityName: string) {
  const getSnapshot = useCallback(() => {
    return localStorage.getItem(storageKey(entityName)) ?? "[]";
  }, [entityName]);

  const raw = useSyncExternalStore(subscribeToViews, getSnapshot, () => "[]");
  const views = useMemo<SavedView[]>(() => {
    try {
      return JSON.parse(raw) as SavedView[];
    } catch {
      return [];
    }
  }, [raw]);

  const createView = useCallback(
    (
      name: string,
      filters: SavedViewFilter[],
      sort?: SavedViewSort,
      columns?: string[],
    ): SavedView => {
      const view: SavedView = {
        id: generateId(),
        name,
        filters,
        sort,
        columns,
        createdAt: new Date().toISOString(),
      };
      const current = readViews(entityName);
      writeViews(entityName, [...current, view]);
      return view;
    },
    [entityName],
  );

  const renameView = useCallback(
    (viewId: string, newName: string): void => {
      const current = readViews(entityName);
      const updated = current.map((v) => (v.id === viewId ? { ...v, name: newName } : v));
      writeViews(entityName, updated);
    },
    [entityName],
  );

  const deleteView = useCallback(
    (viewId: string): void => {
      const current = readViews(entityName);
      writeViews(
        entityName,
        current.filter((v) => v.id !== viewId),
      );
    },
    [entityName],
  );

  const updateView = useCallback(
    (viewId: string, filters: SavedViewFilter[], sort?: SavedViewSort): void => {
      const current = readViews(entityName);
      const updated = current.map((v) => (v.id === viewId ? { ...v, filters, sort } : v));
      writeViews(entityName, updated);
    },
    [entityName],
  );

  return { views, createView, renameView, deleteView, updateView };
}
