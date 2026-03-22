/**
 * Drizzle Data Provider
 *
 * Implements the DataProvider interface using Drizzle ORM
 * for PostgreSQL persistence. Replaces InMemoryStore for production use.
 *
 * Features:
 * - Soft delete (via deleted_at column when available, falls back to physical delete)
 * - Tenant isolation (via tenant_id column when available)
 * - Count queries with filter support
 */

import { and, count, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ConflictError, LinchKitError, NotFoundError, SystemError, ValidationError } from "../errors";
import type { DataProvider, DataQueryOptions } from "./action-engine";
import type { TableRegistry } from "./table-registry";

export class DrizzleDataProvider implements DataProvider {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly tableRegistry: TableRegistry,
  ) {}

  /** Resolve table from registry; throws if not registered. */
  private resolveTable(schemaName: string): PgTable {
    const table = this.tableRegistry.getTable(schemaName);
    if (!table) {
      throw new NotFoundError({
        code: "data.schema.not_registered",
        message: `No table registered for schema "${schemaName}"`,
        resource: "schema",
        resourceId: schemaName,
      });
    }
    return table;
  }

  /** Get a column reference from a table by name. */
  private getColumn(table: PgTable, columnName: string): PgColumn | undefined {
    const columns = getTableColumns(table);
    return columns[columnName] as PgColumn | undefined;
  }

  /**
   * Build base conditions for soft-delete and tenant isolation.
   * Returns an array of SQL conditions to be AND-ed with other filters.
   */
  private buildBaseConditions(table: PgTable, options?: DataQueryOptions): ReturnType<typeof eq>[] {
    const conditions: ReturnType<typeof eq>[] = [];

    // Soft-delete filter: exclude deleted records unless includeDeleted
    if (!options?.includeDeleted) {
      const deletedAtCol = this.getColumn(table, "deleted_at");
      if (deletedAtCol) {
        conditions.push(isNull(deletedAtCol));
      }
    }

    // Tenant isolation
    if (options?.tenantId) {
      const tenantCol = this.getColumn(table, "tenant_id");
      if (tenantCol) {
        conditions.push(eq(tenantCol, options.tenantId));
      }
    }

    return conditions;
  }

  /**
   * Normalize raw database errors into LinchKit error types.
   * Maps postgres error codes to appropriate error classes:
   * - 23505 (unique_violation) → ConflictError
   * - 23503 (foreign_key_violation) → ValidationError
   * - 23502 (not_null_violation) → ValidationError
   * - Others → SystemError
   */
  private normalizeDbError(err: unknown, schema: string): never {
    if (err instanceof LinchKitError) throw err;

    const pgCode = (err as { code?: string })?.code;
    const pgDetail = (err as { detail?: string })?.detail ?? "";
    const pgMessage = (err as { message?: string })?.message ?? "Unknown database error";

    switch (pgCode) {
      case "23505":
        throw new ConflictError({
          code: "data.record.unique_violation",
          message: `Unique constraint violation on ${schema}: ${pgDetail || pgMessage}`,
        });
      case "23503":
        throw new ValidationError({
          code: "data.record.fk_violation",
          message: `Foreign key violation on ${schema}: ${pgDetail || pgMessage}`,
        });
      case "23502":
        throw new ValidationError({
          code: "data.record.not_null_violation",
          message: `NOT NULL violation on ${schema}: ${pgDetail || pgMessage}`,
        });
      default:
        throw new SystemError({
          code: "data.record.db_error",
          message: `Database error on ${schema}: ${pgMessage}`,
          cause: err,
        });
    }
  }

  async get(
    schema: string,
    id: string,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>> {
    const table = this.resolveTable(schema);
    const idCol = this.getColumn(table, "id");
    if (!idCol) {
      throw new NotFoundError({
        code: "data.schema.no_id_column",
        message: `Table for schema "${schema}" has no "id" column`,
        resource: schema,
        resourceId: id,
      });
    }

    const conditions = [eq(idCol, id), ...this.buildBaseConditions(table, options)];

    const rows = await this.db
      .select()
      .from(table)
      .where(and(...conditions))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundError({
        code: "data.record.not_found",
        message: `Record not found: ${schema}/${id}`,
        resource: schema,
        resourceId: id,
      });
    }

    return rows[0] as Record<string, unknown>;
  }

  async query(
    schema: string,
    filter: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Array<Record<string, unknown>>> {
    const table = this.resolveTable(schema);
    const columns = getTableColumns(table);

    // Build WHERE conditions from filter (excluding pagination/sort meta keys)
    const metaKeys = new Set(["page", "pageSize", "sortField", "sortOrder", "offset", "limit"]);
    const conditions = [...this.buildBaseConditions(table, options)];

    for (const [key, value] of Object.entries(filter)) {
      if (metaKeys.has(key)) continue;
      if (value === undefined || value === null) continue;

      const col = columns[key] as PgColumn | undefined;
      if (col) {
        conditions.push(eq(col, value));
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Build query
    let query = this.db.select().from(table);

    if (whereClause) {
      query = query.where(whereClause) as typeof query;
    }

    // Sorting
    const sortField = filter.sortField as string | undefined;
    const sortOrder = (filter.sortOrder as string | undefined) ?? "asc";
    if (sortField) {
      const sortCol = columns[sortField] as PgColumn | undefined;
      if (sortCol) {
        query = query.orderBy(
          sortOrder === "desc" ? sql`${sortCol} desc` : sql`${sortCol} asc`,
        ) as typeof query;
      }
    }

    // Pagination
    const page = filter.page as number | undefined;
    const pageSize = filter.pageSize as number | undefined;
    const rawOffset = filter.offset as number | undefined;
    const rawLimit = filter.limit as number | undefined;

    let effectiveOffset: number | undefined;
    let effectiveLimit: number | undefined;

    if (page !== undefined && pageSize !== undefined) {
      effectiveOffset = (page - 1) * pageSize;
      effectiveLimit = pageSize;
    } else {
      effectiveOffset = rawOffset;
      effectiveLimit = rawLimit;
    }

    if (effectiveLimit !== undefined) {
      query = query.limit(effectiveLimit) as typeof query;
    }
    if (effectiveOffset !== undefined) {
      query = query.offset(effectiveOffset) as typeof query;
    }

    const rows = await query;
    return rows as Array<Record<string, unknown>>;
  }

  async create(schema: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const table = this.resolveTable(schema);
    const now = new Date().toISOString();
    const id = (data.id as string) || crypto.randomUUID();

    const record: Record<string, unknown> = {
      ...data,
      id,
      tenant_id: data.tenant_id ?? null,
      created_at: now,
      updated_at: now,
      created_by: data.created_by ?? null,
      updated_by: data.updated_by ?? null,
      _version: 1,
    };

    // Filter to only columns that exist in the table
    const columns = getTableColumns(table);
    const insertData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key in columns) {
        insertData[key] = value;
      }
    }

    try {
      const rows = await this.db.insert(table).values(insertData).returning();
      return rows[0] as Record<string, unknown>;
    } catch (err) {
      this.normalizeDbError(err, schema);
    }
  }

  async update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const table = this.resolveTable(schema);
    const columns = getTableColumns(table);
    const idCol = this.getColumn(table, "id");
    const versionCol = this.getColumn(table, "_version");

    if (!idCol) {
      throw new NotFoundError({
        code: "data.schema.no_id_column",
        message: `Table for schema "${schema}" has no "id" column`,
        resource: schema,
        resourceId: id,
      });
    }

    const now = new Date().toISOString();

    // Build update payload, filtering to existing columns only
    const updateData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === "id" || key === "_version") continue; // Don't allow overwriting id or _version directly
      if (key in columns) {
        updateData[key] = value;
      }
    }
    updateData.updated_at = now;

    // Optimistic locking: WHERE id = id AND _version = expectedVersion
    const expectedVersion = data._version as number | undefined;
    let whereClause: ReturnType<typeof eq> | ReturnType<typeof and>;

    if (versionCol && expectedVersion !== undefined) {
      whereClause = and(eq(idCol, id), eq(versionCol, expectedVersion));
      // Increment version
      updateData._version = expectedVersion + 1;
    } else if (versionCol) {
      // No version provided — increment from current
      // Use a subquery-style approach: fetch current then increment
      whereClause = eq(idCol, id);
      updateData._version = sql`${versionCol} + 1`;
    } else {
      whereClause = eq(idCol, id);
    }

    let rows: Record<string, unknown>[];
    try {
      rows = await this.db.update(table).set(updateData).where(whereClause).returning() as Record<string, unknown>[];
    } catch (err) {
      this.normalizeDbError(err, schema);
    }

    if (rows.length === 0) {
      // Distinguish between not found and version conflict
      if (expectedVersion !== undefined) {
        // Check if record exists at all
        const existCheck = await this.db
          .select({ total: count() })
          .from(table)
          .where(eq(idCol, id));

        const exists = (existCheck[0]?.total ?? 0) > 0;
        if (exists) {
          // Fetch the actual current version from the row
          const currentRow = await this.db
            .select({ _version: versionCol! })
            .from(table)
            .where(eq(idCol, id))
            .limit(1);
          const actualVersion = (currentRow[0]?._version as number) ?? undefined;
          throw new ConflictError({
            code: "data.record.version_conflict",
            message: `Version conflict: record ${schema}/${id} has been modified (expected version ${expectedVersion}, actual ${actualVersion})`,
            currentVersion: actualVersion,
          });
        }
      }

      throw new NotFoundError({
        code: "data.record.not_found",
        message: `Record not found: ${schema}/${id}`,
        resource: schema,
        resourceId: id,
      });
    }

    return rows[0] as Record<string, unknown>;
  }

  async delete(schema: string, id: string, options?: DataQueryOptions): Promise<void> {
    const table = this.resolveTable(schema);
    const idCol = this.getColumn(table, "id");
    if (!idCol) {
      throw new NotFoundError({
        code: "data.schema.no_id_column",
        message: `Table for schema "${schema}" has no "id" column`,
        resource: schema,
        resourceId: id,
      });
    }

    const deletedAtCol = this.getColumn(table, "deleted_at");

    if (deletedAtCol) {
      // Soft delete: set deleted_at timestamp
      const conditions = [eq(idCol, id), ...this.buildBaseConditions(table, options)];

      const rows = await this.db
        .update(table)
        .set({ deleted_at: new Date().toISOString() } as Record<string, unknown>)
        .where(and(...conditions))
        .returning();

      if (rows.length === 0) {
        throw new NotFoundError({
          code: "data.record.not_found",
          message: `Record not found: ${schema}/${id}`,
          resource: schema,
          resourceId: id,
        });
      }
    } else {
      // No deleted_at column — fall back to physical delete
      const conditions = [eq(idCol, id)];

      // Still apply tenant isolation for physical delete
      if (options?.tenantId) {
        const tenantCol = this.getColumn(table, "tenant_id");
        if (tenantCol) {
          conditions.push(eq(tenantCol, options.tenantId));
        }
      }

      const rows = await this.db
        .delete(table)
        .where(and(...conditions))
        .returning();

      if (rows.length === 0) {
        throw new NotFoundError({
          code: "data.record.not_found",
          message: `Record not found: ${schema}/${id}`,
          resource: schema,
          resourceId: id,
        });
      }
    }
  }

  /** Physical delete — bypasses soft-delete, removes the row permanently. */
  async hardDelete(schema: string, id: string): Promise<void> {
    const table = this.resolveTable(schema);
    const idCol = this.getColumn(table, "id");
    if (!idCol) {
      throw new NotFoundError({
        code: "data.schema.no_id_column",
        message: `Table for schema "${schema}" has no "id" column`,
        resource: schema,
        resourceId: id,
      });
    }

    const rows = await this.db.delete(table).where(eq(idCol, id)).returning();

    if (rows.length === 0) {
      throw new NotFoundError({
        code: "data.record.not_found",
        message: `Record not found: ${schema}/${id}`,
        resource: schema,
        resourceId: id,
      });
    }
  }

  async count(
    schema: string,
    filter?: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<number> {
    const table = this.resolveTable(schema);
    const columns = getTableColumns(table);

    const metaKeys = new Set(["page", "pageSize", "sortField", "sortOrder", "offset", "limit"]);
    const conditions = [...this.buildBaseConditions(table, options)];

    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (metaKeys.has(key)) continue;
        if (value === undefined || value === null) continue;

        const col = columns[key] as PgColumn | undefined;
        if (col) {
          conditions.push(eq(col, value));
        }
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    let query = this.db.select({ total: count() }).from(table);

    if (whereClause) {
      query = query.where(whereClause) as typeof query;
    }

    const result = await query;
    return result[0]?.total ?? 0;
  }
}
