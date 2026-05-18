/**
 * Proposal Migration Detector (Spec 62 §3)
 *
 * Diffs two entity snapshots (`before` / `after`) and emits a list of
 * structured {@link MigrationChange} items. Pure and runtime-agnostic — no
 * Drizzle, no live DB, no Proposal Engine coupling.
 *
 * Rename detection is opt-in: callers pass an optional `renames` map because
 * snapshots alone cannot distinguish "drop X + add Y" from "rename X to Y".
 * The Proposal payload is expected to declare renames explicitly.
 */
import type { FieldDefinition } from "../types/entity";
import type {
  EntitySnapshot,
  MigrationChange,
  MigrationForeignKey,
  MigrationSnapshot,
} from "./proposal-migration-types";

/** Options accepted by {@link detectMigrationChanges}. */
export interface DetectMigrationChangesOptions {
  before: MigrationSnapshot;
  after: MigrationSnapshot;
  /**
   * Explicit per-entity rename map. Keys are entity names; values are
   * `{ from → to }` mappings indicating which `before` field maps to which
   * `after` field. Without this, a diff that removes X and adds Y is treated
   * as a drop+add pair.
   */
  renames?: Record<string, Record<string, string>>;
}

// ── Helpers ──────────────────────────────────────────────────

function fkKey(fk: MigrationForeignKey): string {
  return fk.name ?? `${fk.field}__${fk.toEntity}__${fk.toField ?? "id"}`;
}

function indexForeignKeys(entity: EntitySnapshot): Map<string, MigrationForeignKey> {
  const map = new Map<string, MigrationForeignKey>();
  for (const fk of entity.foreignKeys ?? []) {
    map.set(fkKey(fk), fk);
  }
  return map;
}

// ── Detection ────────────────────────────────────────────────

/**
 * Compute the list of migration changes required to evolve `before` into
 * `after`. Order is stable and deterministic:
 *
 *  1. Table-level changes (create / drop)
 *  2. Column-level renames (per entity)
 *  3. Column-level drops
 *  4. Column-level adds
 *  5. Column type alters
 *  6. FK drops then adds
 *
 * This ordering matches the expand → migrate → contract execution model and
 * keeps the planner simple.
 */
export function detectMigrationChanges(options: DetectMigrationChangesOptions): MigrationChange[] {
  const { before, after, renames = {} } = options;
  const changes: MigrationChange[] = [];

  const beforeNames = new Set(Object.keys(before.entities));
  const afterNames = new Set(Object.keys(after.entities));

  // 1a. Table creates
  for (const name of afterNames) {
    if (!beforeNames.has(name)) {
      const def = after.entities[name];
      if (!def) continue;
      changes.push({ kind: "create_table", entity: name, definition: def });
    }
  }

  // 1b. Table drops
  for (const name of beforeNames) {
    if (!afterNames.has(name)) {
      const def = before.entities[name];
      if (!def) continue;
      changes.push({ kind: "drop_table", entity: name, previousDefinition: def });
    }
  }

  // 2-5. Column-level diff for entities present in both snapshots
  for (const name of afterNames) {
    if (!beforeNames.has(name)) continue;
    const beforeEntity = before.entities[name];
    const afterEntity = after.entities[name];
    if (!beforeEntity || !afterEntity) continue;

    const entityRenames = renames[name] ?? {};
    diffEntityColumns({
      entity: name,
      before: beforeEntity,
      after: afterEntity,
      renames: entityRenames,
      sink: changes,
    });
    diffEntityForeignKeys({
      entity: name,
      before: beforeEntity,
      after: afterEntity,
      sink: changes,
    });
  }

  return changes;
}

interface DiffColumnsOptions {
  entity: string;
  before: EntitySnapshot;
  after: EntitySnapshot;
  renames: Record<string, string>;
  sink: MigrationChange[];
}

function diffEntityColumns(options: DiffColumnsOptions): void {
  const { entity, before, after, renames, sink } = options;

  const renamedFrom = new Set(Object.keys(renames));
  const renamedTo = new Set(Object.values(renames));

  // Emit renames first so subsequent diffs treat them as already handled
  for (const [from, to] of Object.entries(renames)) {
    const def = before.fields[from] ?? after.fields[to];
    if (!def) continue;
    sink.push({
      kind: "rename_column",
      entity,
      fromField: from,
      toField: to,
      definition: def,
    });
  }

  // Drops: in before but not in after, and not part of a rename
  for (const [field, prev] of Object.entries(before.fields)) {
    if (renamedFrom.has(field)) continue;
    if (after.fields[field]) continue;
    sink.push({
      kind: "drop_column",
      entity,
      field,
      previousDefinition: prev,
    });
  }

  // Adds: in after but not in before, and not the target of a rename
  for (const [field, def] of Object.entries(after.fields)) {
    if (renamedTo.has(field)) continue;
    if (before.fields[field]) continue;
    sink.push({
      kind: "add_column",
      entity,
      field,
      definition: def,
    });
  }

  // Type alters: present in both, but `type` differs. Renames are checked
  // separately via the post-rename type because the column name has changed.
  for (const [field, prev] of Object.entries(before.fields)) {
    if (renamedFrom.has(field)) continue;
    const next = after.fields[field];
    if (!next) continue;
    if (prev.type !== next.type) {
      sink.push({
        kind: "alter_column_type",
        entity,
        field,
        fromType: prev.type,
        toType: next.type,
      });
    }
  }

  // Renamed columns may also change type; emit an alter on the new name.
  for (const [from, to] of Object.entries(renames)) {
    const prev = before.fields[from];
    const next = after.fields[to];
    if (!prev || !next) continue;
    if (prev.type !== next.type) {
      sink.push({
        kind: "alter_column_type",
        entity,
        field: to,
        fromType: prev.type,
        toType: next.type,
      });
    }
  }
}

interface DiffForeignKeysOptions {
  entity: string;
  before: EntitySnapshot;
  after: EntitySnapshot;
  sink: MigrationChange[];
}

function diffEntityForeignKeys(options: DiffForeignKeysOptions): void {
  const { entity, before, after, sink } = options;
  const beforeFks = indexForeignKeys(before);
  const afterFks = indexForeignKeys(after);

  // Drops first
  for (const [key, fk] of beforeFks.entries()) {
    if (!afterFks.has(key)) {
      sink.push({ kind: "drop_foreign_key", entity, foreignKey: fk });
    }
  }
  // Then adds
  for (const [key, fk] of afterFks.entries()) {
    if (!beforeFks.has(key)) {
      sink.push({ kind: "add_foreign_key", entity, foreignKey: fk });
    }
  }
}

// ── Convenience builders ─────────────────────────────────────

/**
 * Build a snapshot from a flat array of entity snapshots. Convenience helper
 * for callers that already work with arrays of {@link EntitySnapshot}.
 */
export function buildMigrationSnapshot(entities: EntitySnapshot[]): MigrationSnapshot {
  const map: Record<string, EntitySnapshot> = {};
  for (const e of entities) {
    map[e.name] = e;
  }
  return { entities: map };
}

/**
 * Lightweight check used by the planner / validator: does the type change
 * widen the column (lossless) or narrow it (lossy)?
 *
 * Rules mirror Spec 09 §4.5 widening matrix:
 *  - string  → text:    widen
 *  - date    → datetime: widen
 *  - same → same:        identity (widen)
 *  - everything else:    narrow / incompatible
 */
export function isTypeWidening(
  fromType: FieldDefinition["type"],
  toType: FieldDefinition["type"],
): boolean {
  if (fromType === toType) return true;
  if (fromType === "string" && toType === "text") return true;
  if (fromType === "date" && toType === "datetime") return true;
  return false;
}
