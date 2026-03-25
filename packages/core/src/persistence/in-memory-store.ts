/**
 * In-memory data store — DataProvider for development without PostgreSQL.
 *
 * Stores records per schema in a Map. Supports basic CRUD,
 * filtering, sorting, pagination, soft delete, tenant isolation,
 * and optimistic locking (_version check).
 * No persistence across restarts.
 */

import type { DataProvider, DataQueryOptions } from "../engine/action-engine";
import { ConflictError } from "../errors";

export interface FindManyOptions {
  filter?: Record<string, unknown>;
  sort?: { field: string; order: "asc" | "desc" };
  offset?: number;
  limit?: number;
  /** Tenant isolation — only return records matching this tenant */
  tenantId?: string;
  /** Include soft-deleted records (default: false) */
  includeDeleted?: boolean;
}

export class InMemoryStore implements DataProvider {
  private store = new Map<string, Map<string, Record<string, unknown>>>();

  /** Get or create the table for a schema */
  private table(schema: string): Map<string, Record<string, unknown>> {
    if (!this.store.has(schema)) {
      this.store.set(schema, new Map());
    }
    // Safe: we just set it above if it didn't exist
    return this.store.get(schema) as Map<string, Record<string, unknown>>;
  }

  /** Check if a record is soft-deleted */
  private isDeleted(record: Record<string, unknown>): boolean {
    return record.deleted_at != null;
  }

  async get(
    schema: string,
    id: string,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>> {
    const record = this.table(schema).get(id);
    if (!record) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    // Soft delete check
    if (this.isDeleted(record) && !options?.includeDeleted) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    // Tenant isolation check
    if (options?.tenantId && record.tenant_id !== options.tenantId) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    return { ...record };
  }

  async query(
    schema: string,
    filter: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Array<Record<string, unknown>>> {
    // Extract meta keys (pagination/sort) from filter, pass the rest as data filter
    const metaKeys = new Set(["page", "pageSize", "sortField", "sortOrder", "offset", "limit"]);
    const dataFilter: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filter)) {
      if (!metaKeys.has(k)) {
        dataFilter[k] = v;
      }
    }

    const sortField = filter.sortField as string | undefined;
    const sortOrder = (filter.sortOrder as string | undefined) ?? "asc";
    const sort = sortField ? { field: sortField, order: sortOrder as "asc" | "desc" } : undefined;

    // Support both page/pageSize and offset/limit
    let offset: number | undefined;
    let limit: number | undefined;
    const page = filter.page as number | undefined;
    const pageSize = filter.pageSize as number | undefined;
    if (page !== undefined && pageSize !== undefined) {
      offset = (page - 1) * pageSize;
      limit = pageSize;
    } else {
      offset = filter.offset as number | undefined;
      limit = filter.limit as number | undefined;
    }

    return this.findMany(schema, {
      filter: dataFilter,
      sort,
      offset,
      limit,
      tenantId: options?.tenantId,
      includeDeleted: options?.includeDeleted,
    });
  }

  async create(schema: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
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
    this.table(schema).set(id, record);
    return { ...record };
  }

  async update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>> {
    const existing = this.table(schema).get(id);
    if (!existing) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    // Soft delete check
    if (this.isDeleted(existing) && !options?.includeDeleted) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    // Tenant isolation check
    if (options?.tenantId && existing.tenant_id !== options.tenantId) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    // Optimistic locking: check _version when provided
    const expectedVersion = data._version as number | undefined;
    if (expectedVersion !== undefined) {
      const actualVersion = (existing._version as number) ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new ConflictError({
          code: "data.record.version_conflict",
          message: `Version conflict: record ${schema}/${id} has been modified (expected version ${expectedVersion}, actual ${actualVersion})`,
          currentVersion: actualVersion,
        });
      }
    }

    const now = new Date().toISOString();
    const { _version: _inputVersion, ...restData } = data;
    const updated: Record<string, unknown> = {
      ...existing,
      ...restData,
      id, // Prevent id overwrite
      updated_at: now,
      _version: ((existing._version as number) || 0) + 1,
    };
    this.table(schema).set(id, updated);
    return { ...updated };
  }

  /** Soft delete — sets deleted_at instead of removing the record */
  async delete(schema: string, id: string, options?: DataQueryOptions): Promise<void> {
    const tbl = this.table(schema);
    const record = tbl.get(id);
    if (!record) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    // Match Drizzle behavior: already soft-deleted records are not visible
    if (this.isDeleted(record) && !options?.includeDeleted) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    // Tenant isolation check
    if (options?.tenantId && record.tenant_id !== options.tenantId) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    // Soft delete: set deleted_at timestamp
    record.deleted_at = new Date().toISOString();
    tbl.set(id, record);
  }

  /** Hard delete — actually removes the record from the store */
  async hardDelete(schema: string, id: string): Promise<void> {
    const tbl = this.table(schema);
    if (!tbl.has(id)) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    tbl.delete(id);
  }

  /** Extended findMany with filter, sort, pagination, tenant isolation, soft delete */
  findMany(schema: string, options?: FindManyOptions): Array<Record<string, unknown>> {
    let records = Array.from(this.table(schema).values()).map((r) => ({
      ...r,
    }));

    // Soft delete filter — exclude deleted records unless explicitly included
    if (!options?.includeDeleted) {
      records = records.filter((r) => !this.isDeleted(r));
    }

    // Tenant isolation
    if (options?.tenantId) {
      records = records.filter((r) => r.tenant_id === options.tenantId);
    }

    // Filter
    if (options?.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        if (value !== undefined && value !== null) {
          records = records.filter((r) => r[key] === value);
        }
      }
    }

    // Sort
    if (options?.sort) {
      const { field, order } = options.sort;
      records.sort((a, b) => {
        const aVal = a[field];
        const bVal = b[field];
        if (aVal === bVal) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        const cmp = aVal < bVal ? -1 : 1;
        return order === "desc" ? -cmp : cmp;
      });
    }

    // Pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? records.length;
    return records.slice(offset, offset + limit);
  }

  /** Get total count for a schema (with optional filter, soft delete, and tenant isolation) */
  async count(
    schema: string,
    filter?: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<number> {
    // Strip pagination/sort meta keys to match Drizzle behavior
    const metaKeys = new Set(["page", "pageSize", "sortField", "sortOrder", "offset", "limit"]);
    const dataFilter: Record<string, unknown> = {};
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        if (!metaKeys.has(k)) {
          dataFilter[k] = v;
        }
      }
    }
    return this.findMany(schema, {
      filter: Object.keys(dataFilter).length > 0 ? dataFilter : undefined,
      tenantId: options?.tenantId,
      includeDeleted: options?.includeDeleted,
    }).length;
  }

  /** Seed multiple records at once */
  seed(schema: string, records: Array<Record<string, unknown>>): void {
    for (const record of records) {
      const now = new Date().toISOString();
      const id = (record.id as string) || crypto.randomUUID();
      const full: Record<string, unknown> = {
        ...record,
        id,
        tenant_id: record.tenant_id ?? null,
        created_at: record.created_at ?? now,
        updated_at: record.updated_at ?? now,
        created_by: record.created_by ?? null,
        updated_by: record.updated_by ?? null,
        _version: record._version ?? 1,
      };
      this.table(schema).set(id, full);
    }
  }

  /** Clear all data */
  clear(): void {
    this.store.clear();
  }
}
