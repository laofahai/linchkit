# Semantic Relation Unification

> Status: Draft | Date: 2026-04-07
> Supersedes: Spec 46 (Link Type) partially, Spec 24 (Semantic Relations) partially
> Milestone: M3
>
> Tracking milestones:
> - `M5: Platform Maturity & AI Evolution`
>
> Related issues:
> - GitHub Issue `#87` — Semantic relation unification
>
> Execution source of truth: GitHub milestones and issues.

## 1. Problem

LinchKit currently has **two parallel systems** for describing entity relationships:

1. **Entity field types** (`ref`, `has_many`, `many_to_many`) — embedded in EntityDefinition fields, generate FK/junction tables, but lack semantic meaning and are single-directional.
2. **defineRelation()** (Spec 46) — standalone relation declarations with cardinality and bidirectional labels, also generate FK/junction tables.

Additionally, a **third layer** exists:

3. **SemanticRelation** (Spec 24) — auto-inferred logical relationships (`triggers`, `orchestrates`, `contains`, `references`) used by Ontology, impact analysis, and mermaid export.

Problems:
- **Duplicate paths**: Both entity fields and defineRelation generate the same FK columns. Entity fields get auto-promoted to implicit RelationDefinitions at startup — unnecessary indirection.
- **No semantic identifiers**: `label.from`/`label.to` are display text only. GraphQL field names are derived by appending "s" to entity names (`departments`, `purchase_items`) — not user-defined, not semantic.
- **One relation per entity pair**: `relationBetween(from, to)` returns a single result. Cannot model Person→authored→Document AND Person→reviewed→Document.
- **SemanticRelation duplicates entity-level work**: The inference engine re-derives `contains`/`references` from schema fields — information that should live in RelationDefinition itself.
- **Labels don't support i18n**: No `t:` prefix support.

## 2. Design: Unified Semantic Relations

### 2.1 Core Principle

**One path for all entity relationships: `defineRelation()` with semantic names.**

- Remove `ref`, `has_many`, `many_to_many` from `FieldType`.
- Every entity relationship is declared via `defineRelation()` with mandatory `fromName`/`toName`.
- `SemanticRelation` is pruned to capability-level inference only.

### 2.2 New RelationDefinition

```typescript
interface RelationDefinition {
  /** Unique identifier (e.g. "request_department", "person_authored_doc") */
  name: string

  /** Source entity */
  from: string
  /** Target entity */
  to: string

  /** Structural cardinality */
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many'

  /**
   * Semantic navigation name from the `from` side.
   * Used as: GraphQL field name, code navigation, AI query.
   * Convention: snake_case, English.
   * Example: "department", "authored_documents", "reviewed_documents"
   */
  fromName: string

  /**
   * Semantic navigation name from the `to` side.
   * Used as: GraphQL field name (reverse), code navigation, AI query.
   * Example: "purchase_requests", "authors", "reviewers"
   */
  toName: string

  /**
   * Display labels for UI. Optional. Supports i18n "t:" prefix.
   * Falls back to fromName/toName if not provided.
   */
  label?: {
    from?: string   // "t:relation.department" or "Department"
    to?: string     // "t:relation.purchase_requests" or "Purchase Requests"
  }

  description?: string

  /** Extra fields on M:N junction table (only for many_to_many) */
  properties?: Record<string, FieldDefinition>

  /** Cascade behavior on parent delete. Default: 'none' */
  cascade?: 'none' | 'delete' | 'nullify'

  /** Whether the relationship is required. Default: false */
  required?: boolean
}
```

### 2.3 Key Semantic Properties

**`fromName`** and **`toName`** are:
- **Required** — every relation must have semantic names from both directions.
- **Code identifiers** — English, snake_case, used in GraphQL fields, AI navigation, MCP tools.
- **Unique per entity** — no two relations can produce the same `fromName` on the same entity (or same `toName`). Validated at startup.
- **Not translated** — like field names. The `label` field handles i18n display.

### 2.4 Multiple Relations Between Same Entity Pair

With semantic names, the same pair of entities can have multiple relations:

```typescript
defineRelation({
  name: 'person_authored_doc',
  from: 'person', to: 'document',
  cardinality: 'many_to_many',
  fromName: 'authored_documents',
  toName: 'authors',
})

defineRelation({
  name: 'person_reviewed_doc',
  from: 'person', to: 'document',
  cardinality: 'many_to_many',
  fromName: 'reviewed_documents',
  toName: 'reviewers',
})
```

`RelationRegistry.relationBetween(from, to)` changes to return `RelationDefinition[]` (array).

### 2.5 Cross-Capability Relations

Relations can be defined in **any capability**, not just the one that owns the entity:

```typescript
// In cap-purchase: references user from cap-auth
defineRelation({
  name: 'request_requester',
  from: 'purchase_request', to: 'user',
  cardinality: 'many_to_one',
  fromName: 'requester',
  toName: 'purchase_requests',
})
```

For heavy cross-domain relationships, use a **bridge capability**:

```typescript
defineCapability({
  name: 'cap-purchase-auth-bridge',
  type: 'bridge',
  relations: [/* cross-domain relations */],
})
```

**Conflict rule**: If two capabilities define relations that produce the same `fromName` on the same entity, startup fails with a clear error message.

## 3. Removals

### 3.1 Remove Relationship Field Types

Remove from `FieldType`:
- `"ref"`
- `"has_many"`
- `"many_to_many"`

Remove corresponding interfaces:
- `RefField`
- `HasManyField`
- `ManyToManyField`

Remove from `FieldDefinition` union type.

### 3.2 Remove Auto-Promotion Logic

Delete `convertEntityRelationshipFieldsToImplicitRelations()` from `entity-to-drizzle.ts`. No longer needed — all relations are explicit.

### 3.3 Prune SemanticRelation Inference

Remove entity-level inference from `semantic-inference.ts`:
- Remove `ref` field → `references` inference
- Remove `has_many` field → `contains` inference

Keep capability-level inference:
- `capability.dependencies` → `depends_on`
- `EventHandler` cross-module → `triggers` / `affects`
- `Flow` cross-module steps → `orchestrates`
- `Rule` cross-module context → `reads_from`
- `Bridge` definitions → `bridges` / `affects`

## 4. Affected Systems

### 4.1 Database Schema Generation (`entity-to-drizzle.ts`)

- Remove `SKIPPED_FIELD_TYPES` entries for ref/has_many/many_to_many (or the whole set if empty).
- Remove `isRelationshipField()` type guard.
- `generateRelationColumns()` stays unchanged — it already operates on `RelationDefinition[]`.
- FK column naming uses `{fromName}_id` for many_to_one/one_to_one instead of `{to}_id`. This makes columns semantically meaningful (e.g. `requester_id` instead of `user_id`).

### 4.2 GraphQL Schema Generation (`relation-resolvers.ts`)

Replace entity-name-based field naming with semantic names:

| Before | After |
|--------|-------|
| `fieldName = link.to` (singular) | `fieldName = toCamelCase(link.fromName)` |
| `fieldName = link.from + "s"` (plural) | `fieldName = toCamelCase(link.toName)` |
| `fieldName = otherSchema + "s"` (m2m) | `fieldName = toCamelCase(fromName/toName)` |
| `fieldName = relatedFieldName + "Edges"` (m2m props) | `fieldName = toCamelCase(fromName/toName) + "Edges"` |

Example output:
```graphql
type PurchaseRequest {
  department: Department          # fromName: "department"
  items: [PurchaseItem!]!         # fromName: "items"
  requester: User                 # fromName: "requester"
}
type Department {
  purchaseRequests: [PurchaseRequest!]!  # toName: "purchase_requests"
}
type User {
  purchaseRequests: [PurchaseRequest!]!  # toName: "purchase_requests"
}
```

### 4.3 Zod Validation (`entity-to-zod.ts`)

Remove ref/has_many/many_to_many from `SKIPPED_FIELD_TYPES`. These field types no longer exist in entities, so no skip logic needed.

### 4.4 Validation Engine (`validation-engine.ts`)

Remove the relationship field virtual-field check (lines 292-298). Relationship fields no longer appear in entity field definitions.

### 4.5 MCP JSON Schema (`field-to-json-schema.ts`)

Remove ref/has_many/many_to_many handling. These field types no longer exist.

### 4.6 Documentation Generators (`api-doc-generator.ts`, `openapi-generator.ts`)

Remove ref/has_many/many_to_many special cases. Relations are documented from `RelationRegistry` data, not entity fields.

### 4.7 Semantic Inference (`semantic-inference.ts`)

Remove entity-field scanning (ref → references, has_many → contains). Keep capability-level inference only.

### 4.8 Ontology Registry

`OntologyRegistry.describe()` already includes relation info from `RelationRegistry`. With semantic names, the output becomes richer:

```typescript
{
  relations: [
    {
      relation: requestToDepartment,
      direction: 'outgoing',
      relatedEntity: 'department',
      semanticName: 'department',       // NEW: fromName
      label: 'Department',
    },
  ]
}
```

### 4.9 UI Widgets

The existing widgets (`ref-widget.tsx`, `has-many-widget.tsx`, `many-to-many-widget.tsx`) become **relation widgets** rather than field-type widgets. They are triggered by the relation cardinality rather than field type:

| Cardinality | Widget |
|-------------|--------|
| `many_to_one` / `one_to_one` | RefWidget (combobox select) |
| `one_to_many` | HasManyWidget (inline sub-table) |
| `many_to_many` | ManyToManyWidget (multi-select tags) |

The widget registry registers them by cardinality key instead of field type. The form/list rendering pipeline resolves relation widgets from `RelationRegistry` rather than from entity field definitions.

### 4.10 UI Form Utilities (`entity-form-utils.ts`)

- `RELATION_FIELD_TYPES` set → replaced by a check against `RelationRegistry`
- `COLLECTION_RELATION_TYPES` → replaced by cardinality check (`one_to_many`, `many_to_many`)
- GraphQL subfield selection (`{ id name }`) → driven by relation metadata
- `CHILD_EXCLUDED_TYPES` → no longer needed (relations aren't in entity fields)

### 4.11 Entity List View (`entity-list.tsx`)

Relation columns are resolved via `RelationRegistry.relationsFor(entityName)` instead of scanning entity fields for ref/has_many/many_to_many types. The `fromName`/`toName` provides the GraphQL field name directly.

### 4.12 Auto Form (`auto-form.tsx`)

Virtual record handling and child record collection need to be driven by relation metadata instead of field type checks. The core logic stays the same — only the trigger mechanism changes from `field.type === "ref"` to checking the entity's relations.

### 4.13 MCP Dev Server (`mcp-dev/server.ts`)

Remove ref field special handling. Relation info for AI context comes from `RelationRegistry`.

### 4.14 RelationRegistry API Changes

```typescript
interface RelationRegistry {
  register(relation: RelationDefinition): void

  /** Get all relations for an entity (both directions) */
  relationsFor(entityName: string): RelationInfo[]

  /** Get all relations between two entities (may return multiple) */
  relationsBetween(from: string, to: string): RelationDefinition[]

  /** Find a relation by semantic name on an entity */
  relationByName(entityName: string, semanticName: string): RelationInfo | null

  /** Get all outgoing relations from an entity */
  outgoingRelations(entityName: string): RelationDefinition[]

  /** Get all incoming relations to an entity */
  incomingRelations(entityName: string): RelationDefinition[]

  /** List all registered relations */
  list(): RelationDefinition[]
}

interface RelationInfo {
  relation: RelationDefinition
  direction: 'outgoing' | 'incoming'
  relatedEntity: string
  /** Semantic name for this direction (fromName or toName) */
  semanticName: string
  /** Display label for this direction (from label or toName fallback) */
  label: string
}
```

Key change: `relationBetween()` → `relationsBetween()` (returns array). New: `relationByName()` for semantic lookup.

## 5. Migration of Existing Code

### 5.1 Purchase Demo

Before:
```typescript
// entities/purchase-request.ts
defineEntity({
  name: 'purchase_request',
  fields: {
    department: { type: 'ref', target: 'department' },
    // ...
  },
})

// relations.ts
defineRelation({
  name: 'request_to_department',
  from: 'purchase_request', to: 'department',
  cardinality: 'many_to_one',
  label: { from: 'Department', to: 'Purchase Requests' },
})
```

After:
```typescript
// entities/purchase-request.ts — remove department ref field
defineEntity({
  name: 'purchase_request',
  fields: {
    // department ref removed — now in relations.ts
    // ...
  },
})

// relations.ts — add semantic names
defineRelation({
  name: 'request_to_department',
  from: 'purchase_request', to: 'department',
  cardinality: 'many_to_one',
  fromName: 'department',
  toName: 'purchase_requests',
  label: { from: 't:relation.department', to: 't:relation.purchase_requests' },
})
```

### 5.2 Auth Entities

Auth entities (session, token, api-key) currently use `ref` fields pointing to `user`. These become `defineRelation()` declarations in cap-auth.

## 6. Validation Rules (Startup)

1. **Unique semantic names per entity**: No two relations may produce the same `fromName` or `toName` on the same entity. Error: `"Entity 'person' has duplicate semantic name 'documents' from relations 'person_authored_doc' and 'person_reviewed_doc'"`.
2. **Entity existence**: Both `from` and `to` entities must be registered. Error: `"Relation 'request_to_department' references unknown entity 'department'"`.
3. **Properties only on many_to_many**: `properties` field is only valid when cardinality is `many_to_many`. Error: `"Relation 'x' has properties but cardinality is 'many_to_one'"`.
4. **fromName/toName required**: Both must be non-empty strings. Error: `"Relation 'x' missing fromName"`.
5. **fromName/toName format**: Must be valid identifiers (snake_case, alphanumeric + underscore). Error: `"Relation 'x' fromName 'My Department' is not a valid identifier"`.

## 7. Not In Scope

- **Self-referencing relations** (tree structures) — deferred, same as Spec 46.
- **Polymorphic relations** — not needed yet.
- **Relation-level permissions** — use existing field-level masking.
- **Relation versioning** — not needed.

## 8. Test Impact

Existing tests that create entities with `ref`/`has_many`/`many_to_many` fields need migration to use `defineRelation()`. This affects ~20-30 test files across core, server adapter, and UI packages. All relation-related tests should be updated to verify semantic name behavior.
