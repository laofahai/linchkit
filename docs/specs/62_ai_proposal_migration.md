# AI Proposal Data Migration

> Status: Draft | Date: 2026-04-09
> Target milestone: M7+
>
> Tracking milestones:
> - `M7: Ecosystem`
>
> Related issues:
> - GitHub Issue `#114` — AI proposal data migration
>
> Execution source of truth: GitHub milestones and issues.
>
> Related specs:
> - [09 — Proposal & Validation](./09_proposal_validation_version.md) (governance pipeline, ProposalImpact.migrationRequired)
> - [55 — Evolution System](./55_evolution_system.md) (Insight → Proposal cycle)
> - [59 — Runtime Overlay](./59_runtime_overlay.md) (additive-only runtime field changes)
> - [17 — Legacy System Migration](./17_legacy_system_migration.md) (cap-migration, Drizzle runner)

## 1. Problem

LinchKit's Evolution System (Spec 55) enables AI to observe usage patterns, generate Insights, and propose system changes via Proposals. The Proposal governance pipeline (Spec 09) includes a `migrationRequired` flag in `ProposalImpact`, but **no mechanism exists to bridge an AI-generated Proposal to a safe, validated database migration**.

Current gaps:

| Component | What exists | What's missing |
|-----------|------------|----------------|
| Spec 09 ProposalImpact | `migrationRequired: boolean` | No Phase 3/4 migration validation logic |
| Spec 59 Runtime Overlay | Additive field changes via JSONB `_extensions` | Cannot handle type changes, required fields, or column-level DDL |
| cap-migration | Drizzle runner, entity-mapper, version-registry | No AI→migration bridge; no auto-generation from Proposals |
| Evolution System (Spec 55) | Insight → Proposal with `defineXxx()` code output | No awareness of DB migration consequences |

**The gap:** When AI proposes adding a required field, changing a field type, normalizing data into a new relation, or adding an index — the system has no way to detect the migration need, generate a safe migration plan, validate it, and execute it under governance.

## 2. Scope

This spec covers AI-originated Proposals that require database schema changes. It does NOT cover:

- Manual developer-authored migrations (use `bun ./node_modules/.bin/drizzle-kit` directly)
- Runtime Overlay changes (Spec 59 handles additive JSONB fields)
- Legacy system migration (Spec 17 handles external DB import)

## 3. Migration Detection

When a Proposal modifies entity definitions, the system must classify changes by migration impact:

| Change type | Example | Detection method | Migration needed? |
|-------------|---------|------------------|-------------------|
| Add optional field | `priority?: string` | Diff EntityDefinition fields | Yes — ADD COLUMN |
| Add required field | `supplier_id: string, required` | Diff + check `required` | Yes — ADD COLUMN + backfill |
| Change field type | `amount: string → number` | Diff field types | Yes — ALTER COLUMN + data cast |
| Remove field | Drop `legacy_notes` | Diff removed fields | Yes — DROP COLUMN (destructive) |
| Add index | Index on `status + created_at` | Proposal includes index hint | Yes — CREATE INDEX |
| Add Relation (FK) | `defineRelation({ from: A, to: B })` | New Relation detected | Yes — ADD COLUMN + FK constraint |
| Rename field | `supplier → vendor` | Proposal specifies rename | Yes — RENAME COLUMN + data preserve |
| Data normalization | Extract inline JSON to new entity | Proposal includes new entity + data transform | Yes — CREATE TABLE + data migration |

Detection runs automatically when `ProposalEngine` receives a Proposal with entity-level changes. The output is a `MigrationImpact` object attached to the Proposal.

```typescript
interface MigrationImpact {
  /** Whether any DB migration is needed */
  required: boolean;
  /** Classification of the migration risk */
  risk: 'none' | 'low' | 'medium' | 'high' | 'destructive';
  /** Individual change items */
  changes: MigrationChange[];
  /** Estimated data rows affected (from Memory layer stats) */
  estimatedRowsAffected: number;
  /** Whether the migration is reversible */
  reversible: boolean;
}

interface MigrationChange {
  entity: string;
  changeType: 'add_column' | 'drop_column' | 'alter_column' | 'rename_column'
    | 'add_index' | 'drop_index' | 'add_fk' | 'drop_fk' | 'create_table' | 'data_transform';
  field?: string;
  details: Record<string, unknown>;
  destructive: boolean;
  requiresBackfill: boolean;
}
```

## 4. Migration Plan Generation

Once detection identifies the need, the system generates a migration plan:

1. **Diff computation** — Compare current EntityDefinition (from OntologyRegistry) with proposed EntityDefinition
2. **Drizzle schema generation** — Translate the diff into Drizzle schema changes (leveraging `generateDrizzleSchemaFile()`)
3. **Migration SQL generation** — Run `bun ./node_modules/.bin/drizzle-kit generate` against the new schema to produce SQL
4. **Backfill script** — For required fields or type changes, generate a data backfill query with the default value or transformation logic specified in the Proposal
5. **Rollback script** — Generate the reverse migration (where possible)

```typescript
interface MigrationPlan {
  /** Forward migration SQL statements */
  forwardSql: string[];
  /** Rollback SQL statements (empty if irreversible) */
  rollbackSql: string[];
  /** Data backfill queries */
  backfillSql: string[];
  /** Execution strategy */
  strategy: 'expand-migrate-contract' | 'direct' | 'blue-green';
  /** Estimated execution time based on row count */
  estimatedDuration: string;
  /** Human-readable summary */
  summary: string;
}
```

The plan is attached to `ValidationResult.migrationPlan` (already defined in Spec 09 but not populated).

## 5. Safety Validation

Migration plans go through a dedicated validation pipeline before reaching human approval:

### 5.1 Non-destructive Check

- ADD COLUMN → generally safe, but on older PostgreSQL versions (< 11) with a `DEFAULT` value, may rewrite the entire table and acquire `ACCESS EXCLUSIVE` lock. On PG 11+ with a non-volatile default, this is a metadata-only change.
- DROP COLUMN → **destructive**, requires explicit `allowDestructive` flag in Proposal
- ALTER COLUMN type → safe only if cast is lossless (e.g., `int → bigint`); lossy casts (e.g., `text → int`) blocked
- CREATE INDEX → safe but may lock table; prefer `CREATE INDEX CONCURRENTLY` for large tables. Check estimated row count to decide.

### 5.2 Reversibility Check

Each change is tagged reversible or irreversible:

| Change | Reversible? |
|--------|-------------|
| ADD COLUMN (optional) | Yes — DROP COLUMN |
| ADD COLUMN (required) + backfill | Partial — column can drop, but backfill data lost |
| DROP COLUMN | No — data gone |
| ALTER COLUMN (widening) | Yes — narrow back |
| ALTER COLUMN (narrowing/lossy) | No — data truncated |
| CREATE INDEX | Yes — DROP INDEX |
| Data normalization | No — requires reverse transform |

Irreversible changes require `changeType: 'major'` and mandatory human approval.

### 5.3 Data Loss Simulation

For destructive or lossy changes, the system runs a **dry-run query** to estimate impact:

```sql
-- Example: How many rows have non-null values in the column being dropped?
SELECT COUNT(*) FROM purchase_request WHERE legacy_notes IS NOT NULL;

-- Example: How many values would fail a type cast?
SELECT COUNT(*) FROM purchase_request WHERE amount !~ '^\d+(\.\d+)?$';
```

Results are presented to the human approver as part of the Proposal review.

## 6. Execution Strategy

Following Spec 09's expand-migrate-contract pattern:

### Phase 1: Expand

- Add new columns / tables (nullable, no constraints yet)
- Old code continues to work — new columns are ignored
- Deploy new code that writes to both old and new locations

### Phase 2: Migrate

- Backfill existing data into new columns
- Run in batches to avoid locking (configurable batch size, default 1000 rows)
- Progress tracked in `_linchkit_migration_runs` system table

### Phase 3: Contract

- Add NOT NULL constraints, FK constraints
- Drop old columns (only after verification period)
- Verification period: configurable (default 7 days) — old columns kept but unused

Each phase is a separate Proposal checkpoint. AI can propose Phase 1, but Phase 3 (destructive) always requires fresh human approval.

## 7. Guardrails

Hard rules that cannot be overridden:

1. **Destructive migrations always require human approval** — no auto-approve for DROP COLUMN, lossy ALTER, or data deletes
2. **Production migration requires explicit environment confirmation** — development/staging can auto-execute approved migrations
3. **Batch size limits** — backfill operations are batched; no single UPDATE on entire table
4. **Timeout protection** — migrations exceeding estimated duration by 3x are paused, not killed. Pausing means: the current batch completes, then execution stops. No locks are held during the paused state. Resumption picks up from the last completed batch checkpoint recorded in `_linchkit_migration_runs`.
5. **Concurrent migration lock** — only one migration runs per entity at a time
6. **AI cannot approve its own migration** — Proposals originated by AI require human approval when `migrationRequired: true`

## 8. Integration

### 8.1 ProposalEngine (Spec 09)

- `ProposalImpact.migrationRequired` is now populated by the migration detection step
- `ValidationResult.migrationPlan` is populated by the plan generation step
- Phase 3 (compatibility check) now includes migration safety validation
- Phase 4 (test) now includes dry-run data loss simulation

### 8.2 cap-migration

- `MigrationRunner` gains a new `executeFromPlan(plan: MigrationPlan)` method
- `VersionRegistry` records migration metadata alongside Capability version bumps
- Batch execution, progress tracking, and pause/resume are added to the runner

### 8.3 Runtime Overlay (Spec 59)

- Overlay fields that graduate via `linch overlay promote` now use this spec's migration pipeline
- The promote workflow calls migration detection → plan generation → validation before executing DDL

### 8.4 Evolution System (Spec 55)

- Proposal generation (Section 7 of Spec 55) includes migration impact as part of the Proposal's `backtest` output
- The attention budget factors in migration risk — high-risk migration Proposals get a warning badge in the Insight center

## 9. Implementation Phases

### Phase 1: Detection + Plan (M7)

- [ ] Implement `MigrationImpact` computation from EntityDefinition diffs
- [ ] Integrate into `ProposalEngine` validation pipeline (Phase 3)
- [ ] Generate `MigrationPlan` with forward/rollback SQL via Drizzle

### Phase 2: Safety + Execution (M7)

- [ ] Non-destructive check, reversibility tagging, data loss simulation
- [ ] Extend `MigrationRunner` with `executeFromPlan()` + batch processing
- [ ] Add `_linchkit_migration_runs` tracking table

### Phase 3: Evolution Integration (M8+)

- [ ] Wire Evolution System Proposals to migration pipeline
- [ ] Overlay promotion uses migration pipeline
- [ ] Expand-migrate-contract multi-phase execution with checkpoint approval
