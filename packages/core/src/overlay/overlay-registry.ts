/**
 * OverlayRegistry — in-memory registry for overlay fields
 *
 * Wraps an OverlayStore and provides fast lookup of active overlay fields
 * per entity. Supports change listeners for schema hot-reload.
 */

import type { FieldOverlayRecord, OverlayStore } from "../types/overlay";

/** Listener called when overlays change for a specific entity */
export type OverlayChangeListener = (entityName: string) => void;

export interface OverlayRegistry {
  /** Load all active overlays from store into memory */
  initialize(): Promise<void>;

  /** Get all active overlay fields for an entity */
  overlaysFor(entityName: string): FieldOverlayRecord[];

  /** Register a new overlay field */
  register(
    overlay: Omit<FieldOverlayRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<FieldOverlayRecord>;

  /** Update an existing overlay field */
  update(
    id: string,
    updates: Partial<Pick<FieldOverlayRecord, "fieldName" | "fieldType" | "config" | "status">>,
  ): Promise<FieldOverlayRecord>;

  /** Deprecate an overlay field (soft-delete) */
  deprecate(id: string): Promise<FieldOverlayRecord>;

  /** Subscribe to overlay changes — returns unsubscribe fn */
  onChange(listener: OverlayChangeListener): () => void;
}

export class DefaultOverlayRegistry implements OverlayRegistry {
  private store: OverlayStore;
  /** entityName → active overlay records */
  private cache = new Map<string, FieldOverlayRecord[]>();
  private listeners = new Set<OverlayChangeListener>();

  constructor(store: OverlayStore) {
    this.store = store;
  }

  async initialize(): Promise<void> {
    const all = await this.store.getAllOverlays();
    this.cache.clear();
    for (const record of all) {
      if (record.status !== "active") continue;
      const list = this.cache.get(record.entityName) ?? [];
      list.push(record);
      this.cache.set(record.entityName, list);
    }
  }

  overlaysFor(entityName: string): FieldOverlayRecord[] {
    return this.cache.get(entityName) ?? [];
  }

  async register(
    overlay: Omit<FieldOverlayRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<FieldOverlayRecord> {
    const record = await this.store.addOverlay(overlay);
    if (record.status === "active") {
      const list = this.cache.get(record.entityName) ?? [];
      list.push(record);
      this.cache.set(record.entityName, list);
    }
    this.notifyListeners(record.entityName);
    return record;
  }

  async update(
    id: string,
    updates: Partial<Pick<FieldOverlayRecord, "fieldName" | "fieldType" | "config" | "status">>,
  ): Promise<FieldOverlayRecord> {
    const record = await this.store.updateOverlay(id, updates);
    // Rebuild cache for this entity
    await this.rebuildEntityCache(record.entityName);
    this.notifyListeners(record.entityName);
    return record;
  }

  async deprecate(id: string): Promise<FieldOverlayRecord> {
    const record = await this.store.updateOverlay(id, { status: "deprecated" });
    await this.rebuildEntityCache(record.entityName);
    this.notifyListeners(record.entityName);
    return record;
  }

  onChange(listener: OverlayChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(entityName: string): void {
    for (const listener of this.listeners) {
      try {
        listener(entityName);
      } catch {
        // Swallow listener errors to prevent cascading failures
      }
    }
  }

  private async rebuildEntityCache(entityName: string): Promise<void> {
    const overlays = await this.store.getOverlays(entityName);
    const active = overlays.filter((r) => r.status === "active");
    if (active.length > 0) {
      this.cache.set(entityName, active);
    } else {
      this.cache.delete(entityName);
    }
  }
}
