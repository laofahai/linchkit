/**
 * In-memory data store — simple DataProvider for M0b development.
 *
 * Stores records per schema in a Map. Supports basic CRUD,
 * filtering, sorting, and pagination. No persistence.
 */

import type { DataProvider } from "@linchkit/core";

export interface FindManyOptions {
  filter?: Record<string, unknown>;
  sort?: { field: string; order: "asc" | "desc" };
  offset?: number;
  limit?: number;
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

  async get(schema: string, id: string): Promise<Record<string, unknown>> {
    const record = this.table(schema).get(id);
    if (!record) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    return { ...record };
  }

  async query(
    schema: string,
    filter: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    return this.findMany(schema, { filter });
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
  ): Promise<Record<string, unknown>> {
    const existing = this.table(schema).get(id);
    if (!existing) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    const now = new Date().toISOString();
    const updated: Record<string, unknown> = {
      ...existing,
      ...data,
      id, // Prevent id overwrite
      updated_at: now,
      _version: ((existing._version as number) || 0) + 1,
    };
    this.table(schema).set(id, updated);
    return { ...updated };
  }

  async delete(schema: string, id: string): Promise<void> {
    const tbl = this.table(schema);
    if (!tbl.has(id)) {
      throw new Error(`Record not found: ${schema}/${id}`);
    }
    tbl.delete(id);
  }

  /** Extended findMany with filter, sort, pagination */
  findMany(schema: string, options?: FindManyOptions): Array<Record<string, unknown>> {
    let records = Array.from(this.table(schema).values()).map((r) => ({
      ...r,
    }));

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

  /** Get total count for a schema (with optional filter) */
  count(schema: string, filter?: Record<string, unknown>): number {
    if (!filter) {
      return this.table(schema).size;
    }
    return this.findMany(schema, { filter }).length;
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
