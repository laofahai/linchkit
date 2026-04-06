/**
 * OverlayAwareDataProvider — wraps any DataProvider to handle overlay fields.
 *
 * On write (create/update): separates overlay fields from code-defined fields.
 *   - Code-defined fields go to normal columns via the inner provider.
 *   - Overlay fields are stored in the `_extensions` JSONB column.
 *
 * On read (get/query): spreads `_extensions` values into the root result
 * so consumers see a flat record regardless of where data is physically stored.
 */

import type { DataProvider, DataQueryOptions } from "../engine/action-engine";
import type { OverlayRegistry } from "../overlay/overlay-registry";

/** System fields and meta keys that should never be treated as overlay fields */
const SYSTEM_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "_extensions",
  "deleted_at",
]);

/** Meta keys used for pagination/sorting that should pass through */
const META_KEYS = new Set([
  "page",
  "pageSize",
  "sortField",
  "sortOrder",
  "offset",
  "limit",
  "search",
]);

export class OverlayAwareDataProvider implements DataProvider {
  constructor(
    private readonly inner: DataProvider,
    private readonly overlayRegistry: OverlayRegistry,
  ) {}

  /**
   * Get overlay field names for an entity (active overlays only).
   * Returns a Set of field names that are overlay-managed.
   */
  private getOverlayFieldNames(entityName: string): Set<string> {
    // overlaysFor() already returns only active overlays
    const overlays = this.overlayRegistry.overlaysFor(entityName);
    return new Set(overlays.map((o) => o.fieldName));
  }

  /**
   * Split incoming data into core fields and overlay fields.
   * Overlay fields go into `_extensions`; everything else stays at root.
   */
  private splitFields(
    entityName: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const overlayFields = this.getOverlayFieldNames(entityName);
    if (overlayFields.size === 0) {
      return data;
    }

    const coreData: Record<string, unknown> = {};
    const extensions: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (overlayFields.has(key) && !SYSTEM_FIELDS.has(key) && !META_KEYS.has(key)) {
        extensions[key] = value;
      } else {
        coreData[key] = value;
      }
    }

    // Only set _extensions if there are overlay values
    if (Object.keys(extensions).length > 0) {
      coreData._extensions = extensions;
    }

    return coreData;
  }

  /**
   * Merge _extensions data into an existing _extensions column value.
   * Used during updates to avoid overwriting unrelated overlay fields.
   */
  private mergeExtensions(
    entityName: string,
    data: Record<string, unknown>,
    existingExtensions?: Record<string, unknown>,
  ): Record<string, unknown> {
    const overlayFields = this.getOverlayFieldNames(entityName);
    if (overlayFields.size === 0) {
      return data;
    }

    const coreData: Record<string, unknown> = {};
    const newExtensions: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (overlayFields.has(key) && !SYSTEM_FIELDS.has(key) && !META_KEYS.has(key)) {
        newExtensions[key] = value;
      } else {
        coreData[key] = value;
      }
    }

    if (Object.keys(newExtensions).length > 0 || existingExtensions) {
      coreData._extensions = {
        ...(existingExtensions ?? {}),
        ...newExtensions,
      };
    }

    return coreData;
  }

  /**
   * Spread _extensions fields into the root of a record.
   * The _extensions key itself is removed from the result.
   */
  private spreadExtensions(record: Record<string, unknown>): Record<string, unknown> {
    const extensions = record._extensions as Record<string, unknown> | undefined | null;
    if (!extensions || typeof extensions !== "object") {
      return record;
    }

    const { _extensions, ...rest } = record;
    return {
      ...rest,
      ...extensions,
    };
  }

  async get(
    schema: string,
    id: string,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>> {
    const record = await this.inner.get(schema, id, options);
    return this.spreadExtensions(record);
  }

  async query(
    schema: string,
    filter: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Array<Record<string, unknown>>> {
    const records = await this.inner.query(schema, filter, options);
    return records.map((r) => this.spreadExtensions(r));
  }

  async create(
    schema: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const splitData = this.splitFields(schema, data);
    const record = await this.inner.create(schema, splitData);
    return this.spreadExtensions(record);
  }

  async update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>> {
    // Fetch existing record to preserve existing _extensions values
    let existingExtensions: Record<string, unknown> | undefined;
    try {
      const existing = await this.inner.get(schema, id, options);
      existingExtensions = existing._extensions as Record<string, unknown> | undefined;
    } catch {
      // Record might not exist yet in edge cases; proceed without existing extensions
    }

    const mergedData = this.mergeExtensions(schema, data, existingExtensions);
    const record = await this.inner.update(schema, id, mergedData, options);
    return this.spreadExtensions(record);
  }

  async delete(schema: string, id: string, options?: DataQueryOptions): Promise<void> {
    return this.inner.delete(schema, id, options);
  }

  async count(
    schema: string,
    filter?: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<number> {
    return this.inner.count(schema, filter, options);
  }
}
