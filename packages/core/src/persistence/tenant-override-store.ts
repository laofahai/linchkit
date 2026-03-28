/**
 * Tenant Override Store
 *
 * Loads and manages Layer 2 (runtime) tenant overrides from the database.
 * Only definitions marked as `overridable: true` at Layer 0 can be overridden.
 *
 * @see docs/specs/02_runtime_change.md
 */

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { consoleLogger } from "../observability/console-logger";
import type { Logger } from "../types/logger";
import { tenantOverridesTable } from "./system-tables";

// ── Types ────────────────────────────────────────────────

export type OverrideTargetType = "rule" | "action" | "schema" | "view" | "flow";

export interface TenantOverride {
  id: string;
  tenantId: string;
  targetType: OverrideTargetType;
  targetName: string;
  definition: Record<string, unknown>;
  enabled: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantOverrideStoreOptions {
  db: PostgresJsDatabase;
  logger?: Logger;
}

// ── Store ────────────────────────────────────────────────

export class TenantOverrideStore {
  private db: PostgresJsDatabase;
  private logger: Logger;
  /** In-memory cache: tenantId → targetType → targetName → override */
  private cache = new Map<string, Map<string, Map<string, TenantOverride>>>();

  constructor(options: TenantOverrideStoreOptions) {
    this.db = options.db;
    this.logger = options.logger ?? consoleLogger;
  }

  /** Load all overrides for a tenant into cache */
  async loadTenant(tenantId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(tenantOverridesTable)
      .where(
        and(eq(tenantOverridesTable.tenantId, tenantId), eq(tenantOverridesTable.enabled, true)),
      );

    const typeMap = new Map<string, Map<string, TenantOverride>>();

    for (const row of rows) {
      if (!typeMap.has(row.targetType)) {
        typeMap.set(row.targetType, new Map());
      }
      typeMap.get(row.targetType)?.set(row.targetName, {
        id: row.id,
        tenantId: row.tenantId,
        targetType: row.targetType as OverrideTargetType,
        targetName: row.targetName,
        definition: row.definition as Record<string, unknown>,
        enabled: row.enabled,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }

    this.cache.set(tenantId, typeMap);
    this.logger.debug(`Loaded ${rows.length} override(s) for tenant "${tenantId}"`);
  }

  /** Get a specific override (from cache, or fetch if not cached) */
  async getOverride(
    tenantId: string,
    targetType: OverrideTargetType,
    targetName: string,
  ): Promise<TenantOverride | undefined> {
    // Try cache first
    const cached = this.cache.get(tenantId)?.get(targetType)?.get(targetName);
    if (cached) return cached;

    // If tenant not in cache at all, load it
    if (!this.cache.has(tenantId)) {
      await this.loadTenant(tenantId);
      return this.cache.get(tenantId)?.get(targetType)?.get(targetName);
    }

    return undefined;
  }

  /** Get all overrides for a tenant and target type */
  getOverridesForType(
    tenantId: string,
    targetType: OverrideTargetType,
  ): Map<string, TenantOverride> {
    return this.cache.get(tenantId)?.get(targetType) ?? new Map();
  }

  /** Save or update a tenant override */
  async saveOverride(override: {
    tenantId: string;
    targetType: OverrideTargetType;
    targetName: string;
    definition: Record<string, unknown>;
    updatedBy?: string;
  }): Promise<TenantOverride> {
    const existing = await this.db
      .select()
      .from(tenantOverridesTable)
      .where(
        and(
          eq(tenantOverridesTable.tenantId, override.tenantId),
          eq(tenantOverridesTable.targetType, override.targetType),
          eq(tenantOverridesTable.targetName, override.targetName),
        ),
      )
      .limit(1);

    const existingItem = existing[0];
    if (existingItem) {
      // Update existing
      const [updated] = await this.db
        .update(tenantOverridesTable)
        .set({
          definition: override.definition,
          updatedBy: override.updatedBy ?? null,
          updatedAt: new Date(),
        })
        .where(eq(tenantOverridesTable.id, existingItem.id))
        .returning();

      // Invalidate cache for this tenant
      this.cache.delete(override.tenantId);

      if (!updated) throw new Error("Update returned no rows");
      return {
        ...updated,
        targetType: updated.targetType as OverrideTargetType,
        definition: updated.definition as Record<string, unknown>,
      };
    }

    // Insert new
    const [inserted] = await this.db
      .insert(tenantOverridesTable)
      .values({
        tenantId: override.tenantId,
        targetType: override.targetType,
        targetName: override.targetName,
        definition: override.definition,
        createdBy: override.updatedBy ?? null,
        updatedBy: override.updatedBy ?? null,
      })
      .returning();

    // Invalidate cache for this tenant
    this.cache.delete(override.tenantId);

    if (!inserted) throw new Error("Insert returned no rows");
    return {
      ...inserted,
      targetType: inserted.targetType as OverrideTargetType,
      definition: inserted.definition as Record<string, unknown>,
    };
  }

  /** Delete a tenant override */
  async deleteOverride(
    tenantId: string,
    targetType: OverrideTargetType,
    targetName: string,
  ): Promise<boolean> {
    const result = await this.db
      .delete(tenantOverridesTable)
      .where(
        and(
          eq(tenantOverridesTable.tenantId, tenantId),
          eq(tenantOverridesTable.targetType, targetType),
          eq(tenantOverridesTable.targetName, targetName),
        ),
      )
      .returning();

    // Invalidate cache
    this.cache.delete(tenantId);

    return result.length > 0;
  }

  /** Invalidate cache for a tenant (call after external DB changes) */
  invalidateCache(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Clear all cached data */
  clearCache(): void {
    this.cache.clear();
  }
}
