/**
 * Proposal Migration Planner (Spec 62 §4 + §6)
 *
 * Given a list of detected {@link MigrationChange}s, produce an
 * expand → migrate → contract plan with per-phase SQL strings plus a
 * rollback script. Pure string generation — no Drizzle runtime.
 *
 * SQL emitted here targets PostgreSQL syntax (the project's primary backend).
 * Identifiers are quoted with double quotes and validated against a strict
 * allow-list to defend against injection, since callers may forward Proposal
 * payloads sourced from AI suggestions.
 */
import type { FieldDefinition } from "../types/entity";
import { isTypeWidening } from "./proposal-migration-detector";
import type {
  AddColumnChange,
  AddForeignKeyChange,
  AlterColumnTypeChange,
  CreateTableChange,
  DropColumnChange,
  DropForeignKeyChange,
  DropTableChange,
  EntitySnapshot,
  MigrationChange,
  MigrationClassification,
  MigrationForeignKey,
  MigrationPhase,
  MigrationPlan,
  RenameColumnChange,
} from "./proposal-migration-types";

// ── Identifier safety ────────────────────────────────────────

/**
 * Allow only conservative SQL identifiers: letters, digits, underscores, and
 * a leading non-digit. Anything else throws — Proposals must use entity /
 * field names that already pass the LinchKit naming rules.
 */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

// ── Type mapping ─────────────────────────────────────────────

/**
 * Map a LinchKit field type to its SQL column type. Mirrors the conventions
 * used by `generateDrizzleSchemaFile()` so future integration is seamless.
 */
function sqlTypeFor(type: FieldDefinition["type"]): string {
  switch (type) {
    case "string":
      return "varchar(255)";
    case "text":
      return "text";
    case "number":
      return "double precision";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "timestamp with time zone";
    case "enum":
      // Enums are stored as text; the enum constraint lives at the
      // application layer (Zod) per current LinchKit conventions.
      return "text";
    case "json":
      return "jsonb";
    case "state":
      return "text";
    case "computed":
      // Computed fields are not persisted; planner should never see one.
      throw new Error("Computed fields are not persisted and cannot be migrated");
  }
}

function columnDdlFragment(field: string, def: FieldDefinition): string {
  const sqlType = sqlTypeFor(def.type);
  const nullability = def.required ? "NOT NULL" : "NULL";
  return `${quoteIdent(field)} ${sqlType} ${nullability}`;
}

// ── Classification ───────────────────────────────────────────

const SEVERITY_ORDER: Record<MigrationClassification, number> = {
  safe: 0,
  expand: 1,
  contract: 2,
  breaking: 3,
};

function classifyChange(change: MigrationChange): MigrationClassification {
  switch (change.kind) {
    case "add_column":
      return change.definition.required && change.definition.default === undefined
        ? "expand"
        : "safe";
    case "create_table":
      return "safe";
    case "add_foreign_key":
      return "expand";
    case "drop_column":
      return "contract";
    case "drop_foreign_key":
      return "contract";
    case "drop_table":
      return "contract";
    case "rename_column":
      return "expand";
    case "alter_column_type":
      return isTypeWidening(change.fromType, change.toType) ? "safe" : "breaking";
  }
}

function rollupClassification(changes: MigrationChange[]): MigrationClassification {
  let worst: MigrationClassification = "safe";
  for (const change of changes) {
    const c = classifyChange(change);
    if (SEVERITY_ORDER[c] > SEVERITY_ORDER[worst]) {
      worst = c;
    }
  }
  return worst;
}

// ── Per-change SQL generation ────────────────────────────────

function sqlForCreateTable(change: CreateTableChange): string[] {
  const { entity, definition } = change;
  const columns = Object.entries(definition.fields)
    .filter(([, def]) => def.type !== "computed")
    .map(([name, def]) => `  ${columnDdlFragment(name, def)}`);
  const stmts: string[] = [`CREATE TABLE ${quoteIdent(entity)} (\n${columns.join(",\n")}\n);`];
  for (const fk of definition.foreignKeys ?? []) {
    stmts.push(addForeignKeySql(entity, fk));
  }
  return stmts;
}

function sqlForDropTable(change: DropTableChange): string {
  return `DROP TABLE ${quoteIdent(change.entity)};`;
}

function sqlForAddColumn(change: AddColumnChange): string {
  const fragment = columnDdlFragment(change.field, change.definition);
  return `ALTER TABLE ${quoteIdent(change.entity)} ADD COLUMN ${fragment};`;
}

function sqlForDropColumn(change: DropColumnChange): string {
  return `ALTER TABLE ${quoteIdent(change.entity)} DROP COLUMN ${quoteIdent(change.field)};`;
}

function sqlForAlterColumnType(change: AlterColumnTypeChange): string {
  const sqlType = sqlTypeFor(change.toType);
  return (
    `ALTER TABLE ${quoteIdent(change.entity)} ` +
    `ALTER COLUMN ${quoteIdent(change.field)} TYPE ${sqlType};`
  );
}

function sqlForRenameColumn(change: RenameColumnChange): string {
  return (
    `ALTER TABLE ${quoteIdent(change.entity)} ` +
    `RENAME COLUMN ${quoteIdent(change.fromField)} TO ${quoteIdent(change.toField)};`
  );
}

function addForeignKeySql(entity: string, fk: MigrationForeignKey): string {
  const constraintName = fk.name ?? `fk_${entity}_${fk.field}`;
  const toField = fk.toField ?? "id";
  return (
    `ALTER TABLE ${quoteIdent(entity)} ` +
    `ADD CONSTRAINT ${quoteIdent(constraintName)} ` +
    `FOREIGN KEY (${quoteIdent(fk.field)}) ` +
    `REFERENCES ${quoteIdent(fk.toEntity)}(${quoteIdent(toField)});`
  );
}

function sqlForAddForeignKey(change: AddForeignKeyChange): string {
  return addForeignKeySql(change.entity, change.foreignKey);
}

function sqlForDropForeignKey(change: DropForeignKeyChange): string {
  const fk = change.foreignKey;
  const constraintName = fk.name ?? `fk_${change.entity}_${fk.field}`;
  return (
    `ALTER TABLE ${quoteIdent(change.entity)} ` + `DROP CONSTRAINT ${quoteIdent(constraintName)};`
  );
}

// ── Rollback SQL generation ──────────────────────────────────

function rollbackForChange(change: MigrationChange): string[] {
  switch (change.kind) {
    case "add_column":
      return [`ALTER TABLE ${quoteIdent(change.entity)} DROP COLUMN ${quoteIdent(change.field)};`];
    case "drop_column": {
      const fragment = columnDdlFragment(change.field, change.previousDefinition);
      return [`ALTER TABLE ${quoteIdent(change.entity)} ADD COLUMN ${fragment};`];
    }
    case "alter_column_type": {
      // Only meaningful if the original change was a widening; for narrowing
      // the reverse would also be lossy, but we still emit the SQL so an
      // operator can run it if they accept the risk.
      const sqlType = sqlTypeFor(change.fromType);
      return [
        `ALTER TABLE ${quoteIdent(change.entity)} ` +
          `ALTER COLUMN ${quoteIdent(change.field)} TYPE ${sqlType};`,
      ];
    }
    case "add_foreign_key":
      return [
        sqlForDropForeignKey({
          kind: "drop_foreign_key",
          entity: change.entity,
          foreignKey: change.foreignKey,
        }),
      ];
    case "drop_foreign_key":
      return [
        sqlForAddForeignKey({
          kind: "add_foreign_key",
          entity: change.entity,
          foreignKey: change.foreignKey,
        }),
      ];
    case "rename_column":
      return [
        `ALTER TABLE ${quoteIdent(change.entity)} ` +
          `RENAME COLUMN ${quoteIdent(change.toField)} TO ${quoteIdent(change.fromField)};`,
      ];
    case "create_table":
      return [`DROP TABLE ${quoteIdent(change.entity)};`];
    case "drop_table":
      return sqlForCreateTable({
        kind: "create_table",
        entity: change.entity,
        definition: change.previousDefinition as EntitySnapshot,
      });
  }
}

// ── Phase assignment ─────────────────────────────────────────

interface PhaseBuckets {
  expand: string[];
  migrate: string[];
  contract: string[];
}

function assignToPhases(change: MigrationChange, buckets: PhaseBuckets): void {
  switch (change.kind) {
    case "create_table":
      for (const stmt of sqlForCreateTable(change)) {
        buckets.expand.push(stmt);
      }
      break;
    case "add_column":
      buckets.expand.push(sqlForAddColumn(change));
      break;
    case "add_foreign_key":
      // FKs are added in the contract phase after backfill, but planning
      // for AI Proposals only happens once — keep it in expand for the
      // baseline plan unless a backfill is needed. A future iteration may
      // split this further when Proposal includes backfill data.
      buckets.expand.push(sqlForAddForeignKey(change));
      break;
    case "rename_column":
      // Rename is treated as a migrate-phase action: the column must exist
      // before old code stops reading the old name. In a true blue/green
      // deploy the rename would split into add-new + dual-write; here we
      // emit the rename in `migrate` to signal that timing matters.
      buckets.migrate.push(sqlForRenameColumn(change));
      break;
    case "alter_column_type":
      buckets.migrate.push(sqlForAlterColumnType(change));
      break;
    case "drop_column":
      buckets.contract.push(sqlForDropColumn(change));
      break;
    case "drop_foreign_key":
      buckets.contract.push(sqlForDropForeignKey(change));
      break;
    case "drop_table":
      buckets.contract.push(sqlForDropTable(change));
      break;
  }
}

// ── Summary ──────────────────────────────────────────────────

function summarise(changes: MigrationChange[], classification: MigrationClassification): string {
  if (changes.length === 0) {
    return "No schema changes detected.";
  }
  const counts = new Map<MigrationChange["kind"], number>();
  for (const change of changes) {
    counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [kind, count] of counts.entries()) {
    parts.push(`${count} × ${kind}`);
  }
  return `[${classification}] ${parts.join(", ")}`;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Build a phased migration plan from a list of changes. The returned plan
 * is deterministic: phases preserve insertion order, rollback is the reverse
 * order of the forward steps, and the classification is the worst-case
 * across all changes.
 */
export function planMigration(changes: MigrationChange[]): MigrationPlan {
  const buckets: PhaseBuckets = { expand: [], migrate: [], contract: [] };
  for (const change of changes) {
    assignToPhases(change, buckets);
  }

  const phases: MigrationPhase[] = [];
  if (buckets.expand.length > 0) {
    phases.push({ name: "expand", statements: buckets.expand });
  }
  if (buckets.migrate.length > 0) {
    phases.push({ name: "migrate", statements: buckets.migrate });
  }
  if (buckets.contract.length > 0) {
    phases.push({ name: "contract", statements: buckets.contract });
  }

  // Rollback walks the changes in reverse so dependent ops unwind safely.
  const rollback: string[] = [];
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    if (!change) continue;
    for (const stmt of rollbackForChange(change)) {
      rollback.push(stmt);
    }
  }

  const classification = rollupClassification(changes);
  return {
    changes,
    classification,
    forward: phases,
    rollback,
    summary: summarise(changes, classification),
  };
}
