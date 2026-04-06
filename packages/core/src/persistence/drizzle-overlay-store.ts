/**
 * DrizzleOverlayStore — PostgreSQL-backed OverlayStore via Drizzle ORM.
 *
 * Persists field overlay definitions to _linchkit.field_overlays system table.
 * Each row represents a runtime dynamic field added to an entity.
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
  FieldOverlayDefinition,
  FieldOverlayRecord,
  OverlayFieldType,
  OverlayStatus,
  OverlayStore,
} from "../types/overlay";
import { fieldOverlaysTable } from "./overlay-table";

/** Map a database row to a FieldOverlayRecord */
function rowToRecord(row: typeof fieldOverlaysTable.$inferSelect): FieldOverlayRecord {
  return {
    id: row.id,
    entityName: row.entityName,
    fieldName: row.fieldName,
    fieldType: row.fieldType as OverlayFieldType,
    config: (row.config ?? {}) as FieldOverlayRecord["config"],
    proposalId: row.proposalId ?? undefined,
    status: row.status as OverlayStatus,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleOverlayStore implements OverlayStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  async getOverlays(entityName: string): Promise<FieldOverlayRecord[]> {
    const rows = await this.db
      .select()
      .from(fieldOverlaysTable)
      .where(eq(fieldOverlaysTable.entityName, entityName));
    return rows.map(rowToRecord);
  }

  async getAllOverlays(): Promise<FieldOverlayRecord[]> {
    const rows = await this.db.select().from(fieldOverlaysTable);
    return rows.map(rowToRecord);
  }

  async addOverlay(
    overlay: Omit<FieldOverlayRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<FieldOverlayRecord> {
    const now = new Date();
    const inserted = await this.db
      .insert(fieldOverlaysTable)
      .values({
        entityName: overlay.entityName,
        fieldName: overlay.fieldName,
        fieldType: overlay.fieldType,
        config: overlay.config as Record<string, unknown>,
        proposalId: overlay.proposalId ?? null,
        status: overlay.status,
        createdBy: overlay.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new Error("Failed to insert overlay record");
    }
    return rowToRecord(row);
  }

  async updateOverlay(
    id: string,
    updates: Partial<FieldOverlayDefinition & { status: OverlayStatus }>,
  ): Promise<FieldOverlayRecord> {
    // Build the set clause dynamically — only include provided fields
    const setClause: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (updates.fieldName !== undefined) {
      setClause.fieldName = updates.fieldName;
    }
    if (updates.fieldType !== undefined) {
      setClause.fieldType = updates.fieldType;
    }
    if (updates.config !== undefined) {
      // Merge config: fetch existing first, then merge
      const existing = await this.db
        .select()
        .from(fieldOverlaysTable)
        .where(eq(fieldOverlaysTable.id, id))
        .limit(1);
      if (!existing[0]) {
        throw new Error(`Overlay record not found: ${id}`);
      }
      const mergedConfig = {
        ...((existing[0].config as Record<string, unknown>) ?? {}),
        ...(updates.config as Record<string, unknown>),
      };
      setClause.config = mergedConfig;
    }
    if (updates.status !== undefined) {
      setClause.status = updates.status;
    }

    const updated = await this.db
      .update(fieldOverlaysTable)
      .set(setClause)
      .where(eq(fieldOverlaysTable.id, id))
      .returning();

    const row = updated[0];
    if (!row) {
      throw new Error(`Overlay record not found: ${id}`);
    }
    return rowToRecord(row);
  }

  async removeOverlay(id: string): Promise<void> {
    const result = await this.db
      .delete(fieldOverlaysTable)
      .where(eq(fieldOverlaysTable.id, id))
      .returning({ id: fieldOverlaysTable.id });

    if (result.length === 0) {
      throw new Error(`Overlay record not found: ${id}`);
    }
  }
}
