/**
 * Drizzle Data Provider
 *
 * Implements the DataProvider interface using Drizzle ORM
 * for PostgreSQL persistence. Replaces InMemoryStore for production use.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DataProvider } from "./action-engine";
import type { TableRegistry } from "./table-registry";

export class DrizzleDataProvider implements DataProvider {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly tableRegistry: TableRegistry,
  ) {}

  async get(
    schema: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    // TODO: implement with Drizzle
    // - resolve table from tableRegistry
    // - select where id = id
    // - throw NotFoundError if not found
    void schema;
    void id;
    throw new Error("DrizzleDataProvider.get() not yet implemented");
  }

  async query(
    schema: string,
    filter: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    // TODO: implement with Drizzle
    // - resolve table from tableRegistry
    // - build where clause from filter
    // - return matching rows
    void schema;
    void filter;
    throw new Error("DrizzleDataProvider.query() not yet implemented");
  }

  async create(
    schema: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // TODO: implement with Drizzle
    // - resolve table from tableRegistry
    // - insert data with _version = 1
    // - return created row
    void schema;
    void data;
    throw new Error("DrizzleDataProvider.create() not yet implemented");
  }

  async update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // TODO: implement with Drizzle
    // - resolve table from tableRegistry
    // - optimistic locking: WHERE id = id AND _version = data._version
    // - increment _version
    // - throw ConflictError if no rows updated (stale version)
    // - return updated row
    void schema;
    void id;
    void data;
    throw new Error("DrizzleDataProvider.update() not yet implemented");
  }

  async delete(schema: string, id: string): Promise<void> {
    // TODO: implement with Drizzle
    // - resolve table from tableRegistry
    // - delete where id = id
    // - throw NotFoundError if no rows deleted
    void schema;
    void id;
    throw new Error("DrizzleDataProvider.delete() not yet implemented");
  }
}
