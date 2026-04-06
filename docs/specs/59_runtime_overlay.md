# Runtime Entity Overlay — Schema Modification Without Redeployment

> Status: Draft | Date: 2026-04-06
> Milestone: M3

## 1. Problem

LinchKit entities are defined in code (`defineEntity()`) and compiled into Drizzle schemas at build time via `generateDrizzleSchemaFile()`. Any field addition requires a code change, migration, and redeployment. This creates friction for:

- **AI agents** that discover missing fields during data analysis (e.g., "this entity needs a `priority` field")
- **Business users** who need to capture ad-hoc data without waiting for a developer
- **Rapid prototyping** where schema iteration speed matters more than type safety

The existing infrastructure handles parts of this:

- `extendEntity()` / `overrideEntity()` — design-time only, merged at startup
- `TenantOverrideStore` — runtime Rule/Action parameter overrides, but **no field additions**
- `ProposalEngine` — governance pipeline (draft → approved → deployed), but limited to `add_rule`, `add_automation`, `modify_schema`, `add_default`

**Gap:** No mechanism to add fields at runtime that persist in the database, appear in GraphQL/UI, and are discoverable by AI — all without redeployment.

## 2. Design Goals

- **Additive-only runtime changes** — fields can be added, labels changed, enum values extended. No deletions, no type changes at runtime.
- **Zero-downtime** — overlay changes take effect immediately without server restart.
- **Governance by default** — all overlay changes flow through ProposalEngine.
- **AI-discoverable** — overlay fields appear in OntologyRegistry and MCP tools.
- **Promotion path** — overlay fields can graduate to code-defined fields via CLI.
- **Tenant-scoped** — overlays can be global or per-tenant.

## 3. Non-Goals

- Runtime creation of new Entities (requires Action, State, etc. — too complex for overlay)
- Runtime Relation (FK) creation (requires DDL + Drizzle schema changes)
- Runtime Action or Rule definition (separate concern, covered by ProposalEngine)
- Runtime deletion of code-defined fields
- Field type changes at runtime (string → number)
- Full ALTER TABLE at runtime (overlay fields live in JSONB, not dedicated columns)

## 4. Architecture

```
                         ┌───────────────────────────┐
                         │    ProposalEngine          │
                         │  (governance gate)         │
                         └─────────┬─────────────────┘
                                   │ approved
                                   ▼
┌──────────────┐   register   ┌──────────────────────┐   persist   ┌──────────────────────────┐
│ AI Agent /   │ ──────────►  │  OverlayRegistry     │ ──────────► │ _linchkit_field_overlays  │
│ Business User│              │  (in-memory + DB)     │             │ (system table)            │
└──────────────┘              └──────────┬───────────┘             └──────────────────────────┘
                                         │
                              merge into entity descriptor
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
             ┌───────────┐      ┌──────────────┐     ┌──────────────┐
             │ GraphQL   │      │ DataProvider  │     │ Ontology     │
             │ (dynamic  │      │ (_extensions  │     │ Registry     │
             │  schema)  │      │  JSONB col)   │     │ (describe)   │
             └───────────┘      └──────────────┘     └──────────────┘
```

### 4.1 Storage Model

Every entity table gets a system column:

```sql
_extensions JSONB NOT NULL DEFAULT '{}'
```

This column is added by `generateDrizzleSchemaFile()` alongside other system fields (`id`, `tenant_id`, `created_at`, etc.). A GIN index enables efficient queries:

```sql
CREATE INDEX idx_{table}_extensions ON {table} USING GIN (_extensions);
```

Overlay field **metadata** is stored in a system table (Section 6). Overlay field **values** are stored in the `_extensions` JSONB column of the entity's own table.

### 4.2 OverlayRegistry

The `OverlayRegistry` is an in-memory registry (backed by `_linchkit_field_overlays`) that:

1. Loads all active overlays on startup
2. Merges overlay fields into entity descriptors
3. Accepts new overlays at runtime (after ProposalEngine approval)
4. Notifies subscribers (GraphQL, UI) on changes

## 5. Data Structures

### 5.1 FieldOverlay

```typescript
/** A single overlay field definition */
interface FieldOverlay {
  /** Unique overlay ID (ulid) */
  id: string;
  /** Target entity name */
  entityName: string;
  /** Field name (must not conflict with code-defined fields) */
  fieldName: string;
  /** Field type — restricted to safe runtime types */
  fieldType: OverlayFieldType;
  /** Field constraints */
  constraints: OverlayFieldConstraints;
  /** Display metadata */
  display: OverlayFieldDisplay;
  /** AI hints for ontology */
  aiHints?: OverlayAIHints;
  /** Governance */
  proposalId: string | null;
  /** Scope: null = global, string = tenant-specific */
  tenantId: string | null;
  /** Lifecycle status */
  status: 'active' | 'deprecated' | 'promoted';
  /** Who created this overlay */
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Types safe for runtime addition (no FK, no complex types) */
type OverlayFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'text'      // long text
  | 'json';     // arbitrary JSONB

interface OverlayFieldConstraints {
  required?: boolean;          // default: false (overlays are optional by default)
  defaultValue?: unknown;
  enum?: string[];             // for type 'enum'
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;            // regex validation
}

interface OverlayFieldDisplay {
  label?: Record<string, string>;       // i18n labels: { en: "Priority", "zh-CN": "优先级" }
  description?: Record<string, string>; // i18n descriptions
  placeholder?: Record<string, string>;
  group?: string;                       // field group in form layout
  order?: number;                       // display order within group
  hidden?: boolean;                     // hide from default views
  widget?: string;                      // widget override (from widget registry)
}

interface OverlayAIHints {
  semanticType?: string;       // e.g., "priority", "category", "score"
  description?: string;        // plain English description for AI
  examples?: string[];         // example values
  searchable?: boolean;        // include in AI search (default: true)
}
```

### 5.2 OverlayRegistry Interface

```typescript
interface OverlayRegistry {
  /** Load all active overlays from DB */
  initialize(): Promise<void>;

  /** Get all overlay fields for an entity */
  overlaysFor(entityName: string, tenantId?: string): FieldOverlay[];

  /** Register a new overlay (after proposal approval) */
  register(overlay: Omit<FieldOverlay, 'id' | 'createdAt' | 'updatedAt'>): Promise<FieldOverlay>;

  /** Update an existing overlay (label, description, enum values, etc.) */
  update(id: string, patch: Partial<FieldOverlay>): Promise<FieldOverlay>;

  /** Deprecate an overlay (soft-delete — values remain in _extensions) */
  deprecate(id: string): Promise<void>;

  /** Mark overlay as promoted (migrated to code) */
  markPromoted(id: string): Promise<void>;

  /** Subscribe to overlay changes */
  onChange(listener: (entityName: string) => void): () => void;
}
```

## 6. System Table Schema

```typescript
// Drizzle schema for _linchkit_field_overlays
import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const fieldOverlays = pgTable('_linchkit_field_overlays', {
  id:          text('id').primaryKey(),
  entityName:  text('entity_name').notNull(),
  fieldName:   text('field_name').notNull(),
  fieldType:   text('field_type').notNull(),
  constraints: jsonb('constraints').default('{}').notNull(),
  display:     jsonb('display').default('{}').notNull(),
  aiHints:     jsonb('ai_hints'),
  proposalId:  text('proposal_id'),
  tenantId:    text('tenant_id'),              // null = global
  status:      text('status').notNull().default('active'),
  createdBy:   text('created_by').notNull(),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
  updatedAt:   timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('idx_field_overlays_entity').on(t.entityName),
  index('idx_field_overlays_tenant').on(t.tenantId),
  // Unique: one field name per entity per tenant scope
  // (null tenant = global, specific tenant = tenant-scoped)
]);
```

Uniqueness constraint: `(entity_name, field_name, COALESCE(tenant_id, '__global__'))` — enforced at application level to handle NULL semantics cleanly.

## 7. Boundary Rules

### 7.1 Runtime-Allowed (Additive Only)

| Change | Risk | Auto-approvable? |
|--------|------|-------------------|
| Add optional field (string, number, boolean, date, enum, text, json) | Low | Yes (configurable) |
| Change field label / description | None | Yes |
| Add enum value to existing overlay enum field | Low | Yes |
| Change default value | Low | Yes |
| Add/change AI hints | None | Yes |
| Change display config (group, order, widget, hidden) | None | Yes |
| Mark overlay field as deprecated | Low | Yes |

### 7.2 Requires Code Change

| Change | Reason |
|--------|--------|
| Create new Entity | Requires Action, State, etc. |
| Delete code-defined field | Breaking change, needs migration |
| Change field type (string → number) | Data loss risk |
| Add Relation (FK) | Requires DDL, Drizzle schema |
| Change State machine | Core business logic |
| Change Rule conditions/effects | Core business logic |
| Add required overlay field to entity with existing data | Backfill needed |
| Remove enum value | Breaking change for existing data |

### 7.3 Conflict Prevention

- Overlay field names MUST NOT collide with code-defined field names or system field names.
- Overlay field names MUST NOT collide with other active overlay field names for the same entity + tenant scope.
- Validation runs at `register()` time; rejected with a `conflict` error (409) if violated.

## 8. Integration Points

### 8.1 DataProvider

**Write path:**

```typescript
// ActionEngine separates code-defined fields from overlay fields before persistence
const { codeFields, overlayFields } = splitFields(data, entityDef, overlayRegistry);

// Code fields → normal columns
// Overlay fields → _extensions JSONB
await dataProvider.create(entityName, {
  ...codeFields,
  _extensions: overlayFields,
});
```

**Read path:**

```typescript
// DataProvider auto-spreads _extensions into result
function spreadExtensions(row: Record<string, unknown>): Record<string, unknown> {
  const { _extensions, ...rest } = row;
  return { ...rest, ...(typeof _extensions === 'object' ? _extensions : {}) };
}
```

**Filter path:**

Filtering on overlay fields uses JSONB operators:

```sql
-- Filter: _extensions->>'priority' = 'high'
SELECT * FROM purchase_request
WHERE _extensions->>'priority' = 'high';

-- Numeric comparison: (_extensions->>'score')::numeric > 80
SELECT * FROM purchase_request
WHERE (_extensions->>'score')::numeric > 80;
```

The DataProvider query builder adds JSONB filter support when it detects the target field is an overlay field.

### 8.2 GraphQL

GraphQL schema is rebuilt dynamically when overlays change. `graphql-yoga` supports runtime schema replacement via `yoga.replaceSchema()`.

```typescript
// On overlay change:
overlayRegistry.onChange((entityName) => {
  const newSchema = rebuildGraphQLSchema(entityDefs, overlayRegistry);
  yoga.replaceSchema(newSchema);
});
```

Overlay fields appear as regular fields on the GraphQL type:

```graphql
type PurchaseRequest {
  # Code-defined fields
  id: ID!
  title: String!
  amount: Float!

  # Overlay fields (dynamically added)
  priority: String          # from overlay
  internal_notes: String    # from overlay
}
```

Input types for mutations also include overlay fields.

### 8.3 OntologyRegistry

`OntologyRegistry.describe()` merges overlay fields into the entity descriptor:

```typescript
{
  name: 'purchase_request',
  fields: {
    title: { type: 'string', source: 'code' },
    amount: { type: 'number', source: 'code' },
    priority: { type: 'enum', source: 'overlay', overlayId: 'xxx' },
    internal_notes: { type: 'text', source: 'overlay', overlayId: 'yyy' },
  }
}
```

The `source` field distinguishes code-defined from overlay fields. AI tools (MCP, A2A) see overlay fields and can use them in queries and proposals.

### 8.4 ProposalEngine

New proposal types added to `ProposalType`:

```typescript
type ProposalType =
  | 'add_rule'
  | 'add_automation'
  | 'modify_schema'
  | 'add_default'
  // New overlay proposal types:
  | 'add_field_overlay'
  | 'update_field_overlay'
  | 'deprecate_field_overlay';
```

Proposal `details` for `add_field_overlay`:

```typescript
{
  entityName: string;
  fieldName: string;
  fieldType: OverlayFieldType;
  constraints: OverlayFieldConstraints;
  display: OverlayFieldDisplay;
  aiHints?: OverlayAIHints;
  tenantId?: string;
}
```

**Auto-approval rules:** Configurable per-system. Default: auto-approve adding optional string/text/boolean fields. Require human approval for enum fields (new data constraints) and numeric fields with validation rules.

### 8.5 UI (cap-adapter-ui)

- **AutoForm:** Reads overlay fields from entity descriptor. Renders them using the widget registry (falling back to default widget for the field type).
- **AutoList:** Overlay columns are available in column configuration. Hidden by default unless `display.hidden` is false.
- **Field management UI:** Admin page at `/admin/entities/:name/overlays` to view, create, and manage overlay fields through the ProposalEngine workflow.

### 8.6 REST API

New endpoints under the existing REST pattern:

```
GET    /api/entities/:name/overlays          — List overlay fields
POST   /api/entities/:name/overlays          — Create overlay (creates proposal)
PATCH  /api/entities/:name/overlays/:id      — Update overlay (creates proposal)
DELETE /api/entities/:name/overlays/:id      — Deprecate overlay (creates proposal)
```

All mutating endpoints create a Proposal. The response includes the proposal ID for tracking.

## 9. Promotion Workflow

Overlay fields are useful for rapid iteration but should graduate to code when they stabilize. The promotion workflow converts an overlay field into a proper code-defined field.

### 9.1 CLI Command

```bash
linch overlay promote --entity purchase_request --field priority
```

This command:

1. **Reads** the overlay metadata from `_linchkit_field_overlays`
2. **Generates** a code patch for the entity definition:
   ```typescript
   // Added to purchase_request entity definition:
   priority: { type: 'enum', enum: ['low', 'medium', 'high'], label: { en: 'Priority' } },
   ```
3. **Generates** a Drizzle migration:
   ```sql
   ALTER TABLE purchase_request ADD COLUMN priority TEXT;
   UPDATE purchase_request SET priority = _extensions->>'priority';
   -- Remove from _extensions (optional cleanup)
   UPDATE purchase_request
   SET _extensions = _extensions - 'priority';
   ```
4. **Updates** overlay status to `'promoted'`
5. **(Optional)** Creates a git branch and opens a PR

### 9.2 Promotion Safety

- Promotion is a code-time operation, never runtime
- The overlay remains `active` until the code change is deployed
- After deployment, the overlay transitions to `promoted` status
- `promoted` overlays are ignored by OverlayRegistry (code-defined field takes precedence)
- Backfill migration copies data from `_extensions` to the dedicated column

## 10. Security Considerations

### 10.1 Field Name Validation

Overlay field names are validated against:

- Reserved system field names (`id`, `tenant_id`, `created_at`, etc.)
- Code-defined field names (from EntityDefinition)
- SQL injection patterns (alphanumeric + underscore only, max 63 chars)
- Reserved prefixes (`_linchkit_`, `__`)

### 10.2 Value Validation

All overlay field values pass through Zod validation generated from the overlay's constraints before storage. The validation pipeline:

1. Type coercion (string → number for numeric fields)
2. Constraint validation (required, min, max, pattern, enum membership)
3. Sanitization (strip HTML for string/text fields)

### 10.3 Tenant Isolation

- Global overlays (tenantId = null) are visible to all tenants
- Tenant-scoped overlays are visible only to the owning tenant
- A tenant CANNOT create an overlay that shadows a global overlay field name
- CommandLayer's `tenant` slot enforces isolation

### 10.4 Rate Limiting

- Overlay creation is rate-limited (configurable, default: 10 per entity per hour)
- Prevents abuse by AI agents creating excessive fields
- ProposalEngine approval acts as a secondary gate

## 11. Migration Guide

### 11.1 Adding `_extensions` to Existing Tables

When upgrading from a pre-overlay version:

1. `generateDrizzleSchemaFile()` is updated to include `_extensions` as a system column
2. Run `bun run db:generate` — Drizzle generates ALTER TABLE migrations
3. Run `bun run db:migrate` — applies the migration

The migration adds:

```sql
ALTER TABLE {each_entity_table} ADD COLUMN _extensions JSONB NOT NULL DEFAULT '{}';
CREATE INDEX idx_{table}_extensions ON {table} USING GIN (_extensions);
```

### 11.2 InMemoryStore

`InMemoryStore` already accepts arbitrary fields. For overlay support:

- Overlay fields are stored in a nested `_extensions` key on each record
- Read path spreads `_extensions` to root level (same as Drizzle provider)
- No migration needed

## 12. Implementation Phases

### Phase 1: Foundation (Core)

- [ ] Add `_extensions` JSONB column to `generateDrizzleSchemaFile()` system fields
- [ ] Define `FieldOverlay` types in `@linchkit/core/types`
- [ ] Create `_linchkit_field_overlays` system table schema
- [ ] Implement `OverlayRegistry` (in-memory + DB persistence)
- [ ] Add overlay proposal types to `ProposalEngine`

### Phase 2: DataProvider Integration

- [ ] `DrizzleDataProvider`: write path — split code/overlay fields, store overlay values in `_extensions`
- [ ] `DrizzleDataProvider`: read path — spread `_extensions` to root level
- [ ] `DrizzleDataProvider`: filter path — JSONB operator support for overlay fields
- [ ] `InMemoryStore`: same read/write/filter semantics
- [ ] Validation pipeline for overlay field values

### Phase 3: GraphQL + REST

- [ ] Dynamic GraphQL schema rebuild on overlay change (`yoga.replaceSchema`)
- [ ] Overlay fields in GraphQL query types and input types
- [ ] REST endpoints for overlay CRUD (via ProposalEngine)
- [ ] Auto-approval rules configuration

### Phase 4: OntologyRegistry + AI

- [ ] `describe()` returns overlay fields with `source: 'overlay'`
- [ ] MCP tools discover and query overlay fields
- [ ] AI proposal flow: detect missing field → propose overlay → auto-approve if low-risk

### Phase 5: UI

- [ ] AutoForm renders overlay fields (widget registry integration)
- [ ] AutoList supports overlay columns
- [ ] Admin overlay management page (`/admin/entities/:name/overlays`)

### Phase 6: Promotion CLI

- [ ] `linch overlay promote` command
- [ ] Code patch generation for EntityDefinition
- [ ] Drizzle migration generation (ADD COLUMN + backfill)
- [ ] Optional git branch + PR creation
- [ ] `linch overlay list` — show all overlays and their status

## 13. Open Questions

1. **JSONB vs EAV:** JSONB is chosen for simplicity and PostgreSQL's strong JSONB support (GIN index, operators). EAV (entity-attribute-value) pattern was considered but rejected — more complex queries, worse performance at scale, and PostgreSQL JSONB is battle-tested.

2. **Schema versioning:** Should overlay changes be versioned? Current design uses `updatedAt` + proposal audit trail. A dedicated version counter could be added if rollback support is needed.

3. **Cross-tenant overlay sharing:** Current design allows global (null tenant) and per-tenant overlays. A future enhancement could allow "template" overlays that tenants can opt into.

4. **Overlay field in Rules/Actions:** Can Rules reference overlay fields in conditions? Initial design says yes — overlay fields are indistinguishable from code fields at query time. But Rule validation must handle the case where an overlay field is deprecated.
