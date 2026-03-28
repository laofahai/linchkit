/**
 * Derived Registry (spec 48)
 *
 * Registration, lookup, dependency tracking, topological sorting, cascade
 * map construction, and full lifecycle management for derived fields.
 */

import type { DataProvider } from "../engine/action-engine";
import type { LinkDefinition, LinkRegistryInterface } from "../types/link";
import type { FieldDefinition, SchemaDefinition } from "../types/schema";
import { resolveAggregateValue } from "./aggregate-engine";
import { tokenize } from "./expression-parser";
import { type DerivedConfig, resolveDerivedValue } from "./safe-evaluator";

// ── Interfaces ────────────────────────────────────────────────

/** Information about a derived field registered in the engine */
export interface DerivedFieldInfo {
  schemaName: string;
  fieldName: string;
  fieldDefinition: FieldDefinition;
  derived: DerivedConfig;
  strategy: "store" | "compute";
}

/** Information about a cascade target: which parent schema/field to recalculate */
export interface CascadeTarget {
  /** Parent schema that has the aggregate derived field */
  parentSchema: string;
  /** Field name on the parent schema that needs recalculation */
  parentField: string;
  /** The aggregate derived config */
  derived: import("./safe-evaluator").AggregateDerived;
  /** The link definition connecting child to parent */
  link: LinkDefinition;
  /** FK column name on the child record pointing to the parent */
  fkColumn: string;
}

// ── Config parsing ────────────────────────────────────────────

/**
 * Parse the `derived` property from a FieldDefinition into a typed DerivedConfig.
 * Returns undefined if the field has no derived config or the type is unrecognized.
 */
function parseDerivedConfig(field: FieldDefinition): DerivedConfig | undefined {
  const raw = field.derived;
  if (!raw) return undefined;

  const derivedType = raw.type;

  switch (derivedType) {
    case "expression":
      return {
        type: "expression",
        expr: raw.expr as string,
        strategy: raw.strategy,
        deps: raw.deps,
      };
    case "concat":
      return {
        type: "concat",
        fields: raw.fields as string[],
        separator: raw.separator as string | undefined,
        strategy: raw.strategy,
        deps: raw.deps,
      };
    case "function":
      return {
        type: "function",
        compute: raw.compute as (record: Record<string, unknown>) => unknown,
        strategy: raw.strategy,
        deps: raw.deps,
      };
    case "aggregate":
      return {
        type: "aggregate",
        source: raw.source as { link: string; schema: string; filter?: Record<string, unknown> },
        op: raw.op as "sum" | "count" | "avg" | "min" | "max",
        field: raw.field as string | undefined,
        strategy: raw.strategy,
        deps: raw.deps,
      };
    default:
      return undefined;
  }
}

// ── DerivedPropertyEngine ─────────────────────────────────────

/**
 * DerivedPropertyEngine manages derived field resolution across schemas.
 *
 * It scans schema definitions, collects derived fields, builds a dependency
 * graph, detects cycles, and provides methods to resolve derived values
 * for records.
 *
 * Supports cross-schema aggregate computations (SUM, COUNT, AVG, MIN, MAX)
 * via Link system integration, with cascade recalculation when related records change.
 */
export class DerivedPropertyEngine {
  /** All registered derived fields, keyed by "schema.field" */
  private fields = new Map<string, DerivedFieldInfo>();

  /** Dependency graph: "schema.field" → set of "schema.field" it depends on */
  private depGraph = new Map<string, Set<string>>();

  /** Topological order for store-strategy fields (schema-scoped) */
  private topoOrder = new Map<string, string[]>();

  /** Cascade targets: child schema name → list of parent aggregate fields to recalculate */
  private cascadeMap = new Map<string, CascadeTarget[]>();

  /** Optional link registry for aggregate resolution */
  private linkRegistry?: LinkRegistryInterface;

  /** Optional data provider for aggregate resolution */
  private dataProvider?: DataProvider;

  /**
   * Wire the engine with a link registry and data provider for aggregate support.
   * Call this after register() once the link registry and data provider are available.
   */
  wire(options: { linkRegistry?: LinkRegistryInterface; dataProvider?: DataProvider }): void {
    this.linkRegistry = options.linkRegistry;
    this.dataProvider = options.dataProvider;
    // Rebuild cascade map now that we have the link registry
    if (this.linkRegistry) {
      this.buildCascadeMap();
    }
  }

  /**
   * Register all derived fields from a set of schema definitions.
   * Call this once during startup after all schemas are registered.
   *
   * @throws Error if circular dependencies are detected
   */
  register(schemas: SchemaDefinition[]): void {
    this.fields.clear();
    this.depGraph.clear();
    this.topoOrder.clear();
    this.cascadeMap.clear();

    // Phase 1: collect derived fields
    for (const schema of schemas) {
      for (const [fieldName, field] of Object.entries(schema.fields)) {
        const derived = parseDerivedConfig(field);
        if (!derived) continue;

        const key = `${schema.name}.${fieldName}`;
        const strategy = derived.strategy ?? "store";

        this.fields.set(key, {
          schemaName: schema.name,
          fieldName,
          fieldDefinition: field,
          derived,
          strategy,
        });

        // Build dependency edges (within same schema only for non-aggregate types)
        const deps = new Set<string>();
        const depFieldNames = this.getDependencyFieldNames(derived);
        for (const dep of depFieldNames) {
          deps.add(`${schema.name}.${dep}`);
        }
        this.depGraph.set(key, deps);
      }
    }

    // Phase 2: cycle detection + topological sort per schema
    this.buildTopoOrder(schemas);

    // Phase 3: build cascade map if link registry is available
    if (this.linkRegistry) {
      this.buildCascadeMap();
    }
  }

  /**
   * Build the cascade map: for each aggregate derived field, record which
   * child schema changes should trigger recalculation of the parent field.
   */
  private buildCascadeMap(): void {
    this.cascadeMap.clear();
    if (!this.linkRegistry) return;

    for (const info of this.fields.values()) {
      if (info.derived.type !== "aggregate") continue;

      const agg = info.derived;
      const linkName = agg.source.link;
      const childSchema = agg.source.schema;

      // Find the link definition
      const allLinks = this.linkRegistry.list();
      const link = allLinks.find((l) => l.name === linkName);
      if (!link) continue;

      // Determine FK column on the child record
      let fkColumn: string;
      if (link.from === childSchema) {
        fkColumn = `${link.to}_id`;
      } else {
        fkColumn = `${link.from}_id`;
      }

      const target: CascadeTarget = {
        parentSchema: info.schemaName,
        parentField: info.fieldName,
        derived: agg,
        link,
        fkColumn,
      };

      const existing = this.cascadeMap.get(childSchema) ?? [];
      existing.push(target);
      this.cascadeMap.set(childSchema, existing);
    }
  }

  /**
   * Extract dependency field names from a derived config.
   */
  private getDependencyFieldNames(derived: DerivedConfig): string[] {
    if (derived.deps) return derived.deps;

    switch (derived.type) {
      case "expression": {
        // Extract identifiers from expression
        const tokens = tokenize(derived.expr);
        return tokens.filter((t) => t.type === "identifier").map((t) => t.value);
      }
      case "concat":
        return derived.fields;
      case "function":
        return [];
      case "aggregate":
        return [];
      default:
        return [];
    }
  }

  /**
   * Build topological order per schema. Throws on cycles.
   */
  private buildTopoOrder(schemas: SchemaDefinition[]): void {
    for (const schema of schemas) {
      const schemaFields = new Map<string, Set<string>>();

      // Collect derived fields for this schema
      for (const [key, deps] of this.depGraph.entries()) {
        const info = this.fields.get(key);
        if (info?.schemaName === schema.name) {
          // Filter deps to only those within the same schema that are derived
          const localDeps = new Set<string>();
          for (const dep of deps) {
            if (this.fields.has(dep) && dep.startsWith(`${schema.name}.`)) {
              localDeps.add(dep);
            }
          }
          schemaFields.set(key, localDeps);
        }
      }

      if (schemaFields.size === 0) continue;

      // Kahn's algorithm for topological sort
      // Our graph: key depends on deps. So dep → key (dep must come before key).
      // In-degree of key = number of deps that are also derived fields in this schema.
      const inDegree = new Map<string, number>();
      for (const key of schemaFields.keys()) {
        inDegree.set(key, 0);
      }
      for (const [key, deps] of schemaFields.entries()) {
        for (const dep of deps) {
          if (schemaFields.has(dep)) {
            // key depends on dep → dep should come before key → key gets +1 in-degree
            inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
          }
        }
      }

      const queue: string[] = [];
      for (const [key, deg] of inDegree.entries()) {
        if (deg === 0) queue.push(key);
      }

      const order: string[] = [];
      while (queue.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: queue is non-empty
        const current = queue.shift()!;
        order.push(current);

        // Find all nodes that depend on current
        for (const [key, deps] of schemaFields.entries()) {
          if (deps.has(current)) {
            const newDeg = (inDegree.get(key) ?? 0) - 1;
            inDegree.set(key, newDeg);
            if (newDeg === 0) queue.push(key);
          }
        }
      }

      if (order.length !== schemaFields.size) {
        const remaining = [...schemaFields.keys()].filter((k) => !order.includes(k));
        throw new Error(
          `[derived-property] Circular dependency detected in schema "${schema.name}": ${remaining.map((k) => k.split(".")[1]).join(" <-> ")}`,
        );
      }

      this.topoOrder.set(schema.name, order);
    }
  }

  /**
   * Get all derived fields for a schema.
   */
  getDerivedFields(schemaName: string): DerivedFieldInfo[] {
    const result: DerivedFieldInfo[] = [];
    for (const info of this.fields.values()) {
      if (info.schemaName === schemaName) {
        result.push(info);
      }
    }
    return result;
  }

  /**
   * Get derived fields that use the "compute" (read-time) strategy.
   */
  getComputeFields(schemaName: string): DerivedFieldInfo[] {
    return this.getDerivedFields(schemaName).filter((f) => f.strategy === "compute");
  }

  /**
   * Get derived fields that use the "store" (write-time) strategy.
   */
  getStoreFields(schemaName: string): DerivedFieldInfo[] {
    return this.getDerivedFields(schemaName).filter((f) => f.strategy === "store");
  }

  /**
   * Get aggregate derived fields for a schema.
   */
  getAggregateFields(schemaName: string): DerivedFieldInfo[] {
    return this.getDerivedFields(schemaName).filter((f) => f.derived.type === "aggregate");
  }

  /**
   * Get cascade targets for a child schema.
   * Returns the list of parent schema fields that need recalculation
   * when a record in the child schema is created, updated, or deleted.
   */
  getCascadeTargets(childSchemaName: string): CascadeTarget[] {
    return this.cascadeMap.get(childSchemaName) ?? [];
  }

  /**
   * Check if a child schema has any cascade targets (i.e., any parent schema
   * has aggregate derived fields that depend on this child schema).
   */
  hasCascadeTargets(childSchemaName: string): boolean {
    return (this.cascadeMap.get(childSchemaName) ?? []).length > 0;
  }

  /**
   * Resolve all "compute"-strategy derived fields for a record.
   * Modifies the record in-place and returns it.
   *
   * Call this when reading records (e.g., in GraphQL resolvers or data provider).
   * Note: aggregate compute-strategy fields require resolveComputeFieldsAsync().
   */
  resolveComputeFields(
    schemaName: string,
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const order = this.topoOrder.get(schemaName) ?? [];
    const resolvedFields = new Set<string>();

    // Resolve compute-strategy fields in topological order
    for (const key of order) {
      const info = this.fields.get(key);
      if (!info || info.strategy !== "compute") continue;

      const value = resolveDerivedValue(info.derived, record);
      if (value !== undefined) {
        record[info.fieldName] = value;
      }
      resolvedFields.add(info.fieldName);
    }

    // Also resolve any compute fields not in the topo order
    // (e.g., they have no inter-derived dependencies)
    for (const info of this.fields.values()) {
      if (info.schemaName !== schemaName || info.strategy !== "compute") continue;
      if (resolvedFields.has(info.fieldName)) continue; // Already resolved in topo order

      const value = resolveDerivedValue(info.derived, record);
      if (value !== undefined) {
        record[info.fieldName] = value;
      }
    }

    return record;
  }

  /**
   * Resolve all "compute"-strategy derived fields for a record, including async aggregates.
   * Modifies the record in-place and returns it.
   */
  async resolveComputeFieldsAsync(
    schemaName: string,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // First resolve all non-aggregate compute fields synchronously
    this.resolveComputeFields(schemaName, record);

    // Then resolve aggregate compute fields asynchronously
    if (this.dataProvider && this.linkRegistry) {
      for (const info of this.fields.values()) {
        if (
          info.schemaName !== schemaName ||
          info.strategy !== "compute" ||
          info.derived.type !== "aggregate"
        ) {
          continue;
        }
        const agg = info.derived;
        const allLinks = this.linkRegistry.list();
        const link = allLinks.find((l) => l.name === agg.source.link);
        if (!link) continue;

        const value = await resolveAggregateValue(agg, record, link, this.dataProvider);
        record[info.fieldName] = value;
      }
    }

    return record;
  }

  /**
   * Compute all "store"-strategy derived field values for a record (synchronous).
   * Returns a map of field name → computed value (to be merged into the write payload).
   *
   * Call this before writing a record (e.g., in Action Engine post-action).
   * Note: aggregate store-strategy fields require computeStoreFieldsAsync().
   */
  computeStoreFields(schemaName: string, record: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const order = this.topoOrder.get(schemaName) ?? [];

    // Use a working copy that includes computed values as we go
    const working = { ...record };

    // Resolve store-strategy fields in topological order
    for (const key of order) {
      const info = this.fields.get(key);
      if (!info || info.strategy !== "store") continue;

      // Skip aggregates in sync mode — they need async resolution
      if (info.derived.type === "aggregate") continue;

      const value = resolveDerivedValue(info.derived, working);
      if (value !== undefined) {
        result[info.fieldName] = value;
        working[info.fieldName] = value;
      }
    }

    // Also resolve any store fields not in the topo order
    for (const info of this.fields.values()) {
      if (info.schemaName !== schemaName || info.strategy !== "store") continue;
      if (result[info.fieldName] !== undefined) continue;
      if (info.derived.type === "aggregate") continue;

      const value = resolveDerivedValue(info.derived, working);
      if (value !== undefined) {
        result[info.fieldName] = value;
        working[info.fieldName] = value;
      }
    }

    return result;
  }

  /**
   * Compute all "store"-strategy derived field values for a record, including async aggregates.
   * Returns a map of field name → computed value (to be merged into the write payload).
   */
  async computeStoreFieldsAsync(
    schemaName: string,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Start with sync computations
    const result = this.computeStoreFields(schemaName, record);
    const working = { ...record, ...result };

    // Then resolve aggregate store fields asynchronously
    if (this.dataProvider && this.linkRegistry) {
      for (const info of this.fields.values()) {
        if (
          info.schemaName !== schemaName ||
          info.strategy !== "store" ||
          info.derived.type !== "aggregate"
        ) {
          continue;
        }
        const agg = info.derived;
        const allLinks = this.linkRegistry.list();
        const link = allLinks.find((l) => l.name === agg.source.link);
        if (!link) continue;

        const value = await resolveAggregateValue(agg, working, link, this.dataProvider);
        result[info.fieldName] = value;
        working[info.fieldName] = value;
      }
    }

    // Re-resolve any expression/function fields that depend on aggregate results
    const order = this.topoOrder.get(schemaName) ?? [];
    for (const key of order) {
      const info = this.fields.get(key);
      if (!info || info.strategy !== "store") continue;
      if (info.derived.type === "aggregate") continue;

      // Check if any dependency is an aggregate field
      const depNames = this.getDependencyFieldNames(info.derived);
      const hasAggDep = depNames.some(
        (d) => result[d] !== undefined && this.fields.get(`${schemaName}.${d}`)?.derived.type === "aggregate",
      );
      if (hasAggDep) {
        const value = resolveDerivedValue(info.derived, working);
        if (value !== undefined) {
          result[info.fieldName] = value;
          working[info.fieldName] = value;
        }
      }
    }

    return result;
  }

  /**
   * Cascade recalculate: when a child record is created, updated, or deleted,
   * find all affected parent records and recalculate their aggregate derived fields.
   * Recursively cascades up the chain if the parent schema itself has cascade targets,
   * up to `maxCascadeDepth` levels (default 5) to prevent infinite loops.
   *
   * @param childSchemaName - The schema of the record that changed
   * @param childRecord - The child record (for extracting FK values to find parent records)
   * @param dataProvider - Data provider for querying and updating parent records
   * @param options - Optional settings: maxCascadeDepth (default 5)
   * @returns Map of "parentSchema.parentId" → updated field values
   */
  async cascadeRecalculate(
    childSchemaName: string,
    childRecord: Record<string, unknown>,
    dataProvider?: DataProvider,
    options?: { maxCascadeDepth?: number },
  ): Promise<Map<string, Record<string, unknown>>> {
    const maxDepth = options?.maxCascadeDepth ?? 5;
    return this._cascadeRecalculateInternal(childSchemaName, childRecord, dataProvider, maxDepth, 0);
  }

  /**
   * Internal recursive cascade implementation with depth tracking.
   */
  private async _cascadeRecalculateInternal(
    childSchemaName: string,
    childRecord: Record<string, unknown>,
    dataProvider: DataProvider | undefined,
    maxDepth: number,
    currentDepth: number,
  ): Promise<Map<string, Record<string, unknown>>> {
    const dp = dataProvider ?? this.dataProvider;
    if (!dp) return new Map();

    if (currentDepth >= maxDepth) return new Map();

    const targets = this.getCascadeTargets(childSchemaName);
    if (targets.length === 0) return new Map();

    const updates = new Map<string, Record<string, unknown>>();

    for (const target of targets) {
      // Find the parent record ID from the child record's FK column
      const parentId = childRecord[target.fkColumn] as string | undefined;
      if (!parentId) continue;

      // Get the parent record
      let parentRecord: Record<string, unknown>;
      try {
        parentRecord = await dp.get(target.parentSchema, parentId);
      } catch {
        // Parent not found — skip (may have been deleted)
        continue;
      }

      // Recalculate the aggregate field
      const value = await resolveAggregateValue(
        target.derived,
        parentRecord,
        target.link,
        dp,
      );

      // Collect update for this parent
      const updateKey = `${target.parentSchema}.${parentId}`;
      const existing = updates.get(updateKey) ?? {};
      existing[target.parentField] = value;
      updates.set(updateKey, existing);

      // Apply the update to the parent record
      await dp.update(target.parentSchema, parentId, { [target.parentField]: value });

      // Check if there are non-aggregate store fields that depend on this aggregate field
      const storeFields = this.getStoreFields(target.parentSchema);
      const updatedParent = { ...parentRecord, [target.parentField]: value };
      for (const sf of storeFields) {
        if (sf.derived.type === "aggregate") continue;
        const deps = this.getDependencyFieldNames(sf.derived);
        if (deps.includes(target.parentField)) {
          const recomputed = resolveDerivedValue(sf.derived, updatedParent);
          if (recomputed !== undefined) {
            existing[sf.fieldName] = recomputed;
            updatedParent[sf.fieldName] = recomputed;
            await dp.update(target.parentSchema, parentId, { [sf.fieldName]: recomputed });
          }
        }
      }

      // Recursively cascade: if the parent schema itself has cascade targets,
      // propagate the change upward
      if (this.hasCascadeTargets(target.parentSchema)) {
        const parentUpdates = await this._cascadeRecalculateInternal(
          target.parentSchema,
          updatedParent,
          dp,
          maxDepth,
          currentDepth + 1,
        );
        // Merge recursive updates into our result
        for (const [key, val] of parentUpdates) {
          const existingVal = updates.get(key);
          if (existingVal) {
            Object.assign(existingVal, val);
          } else {
            updates.set(key, val);
          }
        }
      }
    }

    return updates;
  }

  /**
   * Check if a field is derived.
   */
  isDerived(schemaName: string, fieldName: string): boolean {
    return this.fields.has(`${schemaName}.${fieldName}`);
  }

  /**
   * Get info for a specific derived field.
   */
  getFieldInfo(schemaName: string, fieldName: string): DerivedFieldInfo | undefined {
    return this.fields.get(`${schemaName}.${fieldName}`);
  }
}

// ── Factory ──────────────────────────────────────────────────

/** Create a new DerivedPropertyEngine instance */
export function createDerivedPropertyEngine(): DerivedPropertyEngine {
  return new DerivedPropertyEngine();
}
