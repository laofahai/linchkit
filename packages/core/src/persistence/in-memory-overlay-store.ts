/**
 * In-memory overlay store
 *
 * Map-based implementation of OverlayStore for testing and no-DB mode.
 * No persistence across restarts.
 */

import type {
  FieldOverlayDefinition,
  FieldOverlayRecord,
  OverlayStatus,
  OverlayStore,
} from "../types/overlay";

/** Generate a random ID with the overlay prefix */
function generateId(): string {
  return `overlay_${crypto.randomUUID()}`;
}

export class InMemoryOverlayStore implements OverlayStore {
  private records = new Map<string, FieldOverlayRecord>();

  async getOverlays(entityName: string): Promise<FieldOverlayRecord[]> {
    return Array.from(this.records.values()).filter((r) => r.entityName === entityName);
  }

  async getAllOverlays(): Promise<FieldOverlayRecord[]> {
    return Array.from(this.records.values());
  }

  async addOverlay(
    overlay: Omit<FieldOverlayRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<FieldOverlayRecord> {
    // Enforce unique constraint: (entityName, fieldName)
    for (const existing of this.records.values()) {
      if (existing.entityName === overlay.entityName && existing.fieldName === overlay.fieldName) {
        throw new Error(
          `Overlay field "${overlay.fieldName}" already exists on entity "${overlay.entityName}"`,
        );
      }
    }

    const now = new Date();
    const record: FieldOverlayRecord = {
      ...overlay,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return record;
  }

  async updateOverlay(
    id: string,
    updates: Partial<FieldOverlayDefinition & { status: OverlayStatus }>,
  ): Promise<FieldOverlayRecord> {
    const existing = this.records.get(id);
    if (!existing) {
      throw new Error(`Overlay record not found: ${id}`);
    }

    // If fieldName is being changed, check uniqueness constraint
    if (updates.fieldName && updates.fieldName !== existing.fieldName) {
      for (const record of this.records.values()) {
        if (record.entityName === existing.entityName && record.fieldName === updates.fieldName) {
          throw new Error(
            `Overlay field "${updates.fieldName}" already exists on entity "${existing.entityName}"`,
          );
        }
      }
    }

    const updated: FieldOverlayRecord = {
      ...existing,
      ...updates,
      // Merge config if both exist
      config: updates.config ? { ...existing.config, ...updates.config } : existing.config,
      updatedAt: new Date(),
    };
    this.records.set(id, updated);
    return updated;
  }

  async removeOverlay(id: string): Promise<void> {
    if (!this.records.has(id)) {
      throw new Error(`Overlay record not found: ${id}`);
    }
    this.records.delete(id);
  }

  /** Clear all records (useful for test cleanup) */
  clear(): void {
    this.records.clear();
  }
}
