# Data-Level i18n Architecture — Comprehensive Design

> Spec: 51 | Status: Active | Supersedes: spec 41 (original data i18n design)
> Last Updated: 2026-03-26

## 1. Overview

LinchKit has three i18n layers:

| Layer | Content | Approach | Status |
|-------|---------|----------|--------|
| UI strings | Buttons, labels, toasts | react-i18next, JSON translation files | Implemented |
| Schema metadata | schema.label, field.label | `t:` prefix convention + i18next | Implemented |
| **Business data** | User-entered multilingual content | **This document** | Core implemented, gaps remain |

This spec defines the complete architecture for **business data i18n** — translatable record field values such as product names, descriptions, and category labels.

Typical scenarios:
- Product name in Chinese and English
- Document description in multiple languages
- Enum option display labels requiring translation

## 2. Approach Comparison

### 2.1 Translation Table (Odoo `ir.translation`)

```
ir_translation(src_model, src_field, src_id, lang, value)
```

| Aspect | Assessment |
|--------|-----------|
| Storage | Separate table, one row per (model, field, record, lang) |
| Reads | JOIN required for every translatable field |
| Writes | INSERT/UPDATE in translation table alongside main record |
| Adding languages | No schema change needed |
| Indexing | Standard B-tree on value column |
| Drawback | Heavy JOINs (N+1 without batching), data consistency across two tables, violates LinchKit's "DB stores business data, not meta-definitions" principle |

### 2.2 Content Versioning (Strapi)

| Aspect | Assessment |
|--------|-----------|
| Storage | Full record copy per locale, linked via `localizations` relation |
| Reads | Simple — filter by locale, no JOINs |
| Writes | Duplicate non-translatable fields across all locale copies |
| Adding languages | INSERT new record copy |
| Drawback | Massive redundancy (price, SKU, dates duplicated per locale), complex relation management, `ref` fields must be locale-aware |

### 2.3 Per-Schema Translation Table (Directus)

| Aspect | Assessment |
|--------|-----------|
| Storage | `xxx_translations(id, xxx_id, language, field1, field2...)` per schema |
| Reads | Single JOIN to translation table |
| Writes | Upsert in translation table |
| Adding languages | INSERT new row in translation table |
| Drawback | One extra table per schema, Drizzle schema generation complexity doubles |

### 2.4 JSONB Inline (Payload CMS / Chosen)

```sql
name jsonb  -- {"en": "Purchase Order", "zh-CN": "采购订单"}
```

| Aspect | Assessment |
|--------|-----------|
| Storage | Translatable fields stored as JSONB in same table |
| Reads | No JOIN — single query, resolve in application layer |
| Writes | Standard UPDATE on same column |
| Adding languages | No schema change, no migration |
| Indexing | Expression index `((name->>'en'))` or GIN for full-text |
| Drawback | Slightly larger storage; expression indexes needed for search |

### 2.5 Decision: JSONB Inline

**Rationale:**

| Factor | Why JSONB wins |
|--------|---------------|
| KISS | No extra tables, no JOINs, simplest implementation |
| Performance | Single query retrieves all translations; no N+1 |
| Code-first schema | Drizzle generates `jsonb` column directly — no translation table DDL |
| Flexibility | New languages added without migration |
| Drizzle compatibility | Native `jsonb` support in drizzle-orm |
| AI-native | MCP tools receive full locale map — AI chooses language contextually |

**Why NOT translation table:** LinchKit's schema is code-first. A translation table requires runtime metadata management, violating "DB only stores business data."

**Why NOT content versioning:** Unacceptable redundancy; relation management becomes locale-aware.

## 3. Schema Definition

### 3.1 Marking Fields as Translatable

```typescript
import { defineSchema } from '@linchkit/core'

export const product = defineSchema({
  name: 'product',
  label: 't:schema.product',

  // Enable data i18n for this schema
  i18n: {
    defaultLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en', 'ja'],  // optional — informational
  },

  fields: {
    name:        { type: 'string', required: true, translatable: true },
    description: { type: 'text', translatable: true },
    sku:         { type: 'string', required: true },  // identifiers: NOT translatable
    price:       { type: 'number' },                   // numbers: NOT translatable
    category:    { type: 'ref', target: 'category' },  // refs: NOT translatable
  },
})
```

### 3.2 Type Definitions

Already implemented in `packages/core/src/types/schema.ts`:

```typescript
// SchemaI18nConfig — on SchemaDefinition.i18n
interface SchemaI18nConfig {
  defaultLocale?: string
  supportedLocales?: string[]
}

// BaseFieldDefinition — translatable flag
interface BaseFieldDefinition extends FieldConstraints {
  // ... existing fields
  translatable?: boolean
}
```

### 3.3 Validation Rules

Enforced by `validateTranslatableSchema()` in `packages/core/src/schema/translatable.ts`:

1. **Type restriction**: Only `string`, `text`, and `enum` fields can be `translatable: true`. Others produce a build-time error.
2. **Config requirement**: If any field is translatable, the schema MUST declare `i18n.defaultLocale`.
3. **System fields**: System fields (`id`, `tenant_id`, `created_at`, etc.) are never translatable.
4. **Ref fields**: Relationship fields (`ref`, `has_many`, `many_to_many`) cannot be translatable (the referenced record handles its own translations).

## 4. Database Storage

### 4.1 Column Generation

`schema-to-drizzle.ts` generates `jsonb` columns for translatable fields:

```typescript
// When field.translatable === true && type in {string, text, enum}
// → jsonb column instead of varchar/text
if (field.translatable && TRANSLATABLE_FIELD_TYPES.has(field.type)) {
  col = jsonb(name)
}
```

Resulting DDL:

```sql
CREATE TABLE product (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  name        jsonb NOT NULL,    -- translatable → jsonb
  description jsonb,             -- translatable → jsonb
  sku         varchar NOT NULL,  -- normal → varchar
  price       numeric,
  -- system fields...
);
```

### 4.2 JSONB Value Format

```jsonc
// Stored value for a translatable field
{
  "zh-CN": "采购订单模板",
  "en": "Purchase Order Template"
}
```

- Keys are locale codes (BCP 47 compatible)
- Values are plain strings
- Default locale's value MUST exist (enforced by validation)

### 4.3 Index Strategy

Indexes are developer-managed via Drizzle migrations, not auto-created:

```sql
-- Expression index for locale-specific sorting/filtering
CREATE INDEX idx_product_name_zh ON product ((name->>'zh-CN'));
CREATE INDEX idx_product_name_en ON product ((name->>'en'));

-- GIN index for full-text search across all locales
CREATE INDEX idx_product_name_gin ON product USING GIN (name);
```

## 5. Read/Write Flow

### 5.1 Write Path (Normalization)

`normalizeTranslatableRow()` processes input before storage:

```
User input → normalizeTranslatableRow() → DB
```

**Shortcut syntax**: Plain string input is auto-wrapped:
```typescript
// Input: { name: "采购订单" }
// Normalized: { name: { "zh-CN": "采购订单" } }
```

**Full syntax**: Object input passed through:
```typescript
// Input: { name: { "zh-CN": "采购订单", "en": "Purchase Order" } }
// Normalized: same as input
```

### 5.2 Read Path (Resolution)

`resolveTranslatableRow()` processes output before delivery:

```
DB → resolveTranslatableRow(row, schema, locale) → API response
```

**Fallback chain** (implemented in `resolveTranslatableValue()`):
1. Exact locale match (e.g., `"zh-CN"`)
2. Language prefix match (e.g., `"zh"` matches `"zh-CN"` or `"zh-TW"`)
3. Schema's `defaultLocale`
4. First available value in JSONB

### 5.3 InMemoryStore Compatibility

InMemoryStore stores JSONB values as JavaScript objects natively. The same `resolveTranslatableRow()` / `normalizeTranslatableRow()` helpers work identically — they operate on plain objects, not SQL-specific types.

## 6. GraphQL API

### 6.1 Type Generation

For each translatable field, two GraphQL fields are generated:

```graphql
type Product {
  # Resolved to a single string based on request locale + fallback chain
  name: String!

  # Full locale map as JSON string (e.g., '{"zh-CN":"采购订单","en":"Purchase Order"}')
  name_i18n: String

  description: String
  description_i18n: String

  sku: String!  # Non-translatable — normal scalar
}
```

### 6.2 Query with Locale

Locale is passed via HTTP header and injected into `GraphQLContext.locale`:

```graphql
# Client sends: Accept-Language: en
query {
  products {
    name          # → "Purchase Order Template"
    description   # → "Standard purchase order template"
  }
}

# To get all translations:
query {
  products {
    name_i18n     # → '{"zh-CN":"采购订单模板","en":"Purchase Order Template"}'
  }
}
```

### 6.3 Mutation with Locale

Translatable fields in mutations accept:
- **Plain string**: Wrapped with request locale (or defaultLocale)
- **JSON-encoded locale map**: `'{"en":"Hello","zh-CN":"你好"}'` — parsed and stored as JSONB

```graphql
mutation {
  createProduct(input: {
    name: "New Product"        # Wrapped as {"en": "New Product"} if locale=en
    sku: "SKU-001"
    price: 99.99
  }) {
    id
    name
  }
}

# Setting multiple translations at once:
mutation {
  updateProduct(
    id: "prod-1"
    input: {
      name: "{\"en\":\"Updated Name\",\"zh-CN\":\"更新名称\"}"
    }
  ) {
    name
    name_i18n
  }
}
```

### 6.4 Locale Resolution in Context

```typescript
// GraphQLContext (in build-schema.ts)
interface GraphQLContext {
  actor: Actor
  tenantId?: string
  locale?: string  // Resolved from Accept-Language header or actor preference
  // ...
}
```

Locale priority:
1. Explicit `locale` query parameter
2. `Accept-Language` HTTP header
3. Actor's preferred locale (from user profile)
4. System default locale

### 6.5 Subscription Support

GraphQL subscriptions (SSE-based) include locale resolution. Event payloads containing translatable fields are resolved using the subscriber's locale from the connection context.

## 7. REST API

### 7.1 CRUD Endpoints

REST endpoints (`/api/schemas/:name`) apply the same normalization/resolution:

- **Read**: Response body contains resolved values for the request locale
- **Write**: Request body accepts plain strings (auto-wrapped) or locale maps

Locale determined by `Accept-Language` header.

### 7.2 Translation Management Endpoint (Future — P5)

```
GET    /api/schemas/:name/:id/translations
       → Returns all translations for all translatable fields

PUT    /api/schemas/:name/:id/translations/:locale
       → Set/update translations for a specific locale
       Body: { "name": "translated name", "description": "translated desc" }

DELETE /api/schemas/:name/:id/translations/:locale
       → Remove translations for a specific locale
```

## 8. MCP Integration

MCP tools receive **full JSONB locale maps**, not resolved strings. This allows AI agents to:
- Choose the appropriate language contextually
- Present multilingual content
- Update specific locale translations

```typescript
// MCP tool response for describe_schema
{
  fields: {
    name: { type: "string", translatable: true },
    // ...
  }
}

// MCP query result
{
  name: { "zh-CN": "采购订单", "en": "Purchase Order" }
}
```

## 9. Subsystem Interactions

| Subsystem | Behavior |
|-----------|----------|
| **Action Engine** | `normalizeTranslatableRow()` applied to input before handler execution |
| **Rule Engine** | Conditions compare against `defaultLocale` value by default |
| **Search/Filter** | JSONB containment query (`@>`) or expression extraction (`->>`) for locale-specific search |
| **Event Bus** | Event payloads carry full JSONB objects (not resolved) |
| **DataLoader** | Link resolvers batch-fetch related records; translatable resolution applied after fetch |
| **Soft Delete** | Translatable fields preserved in soft-deleted records; restored intact |
| **Export** | Configurable: export single locale or all translations |
| **Derived Properties** | Derived fields that depend on translatable fields operate on resolved values |
| **Data Masking** | Masking applied AFTER locale resolution (masks the resolved string, not JSONB) |

## 10. Enum Field Translations

Enum option labels are **schema metadata**, not user data. They use the `t:` prefix convention:

```typescript
fields: {
  priority: {
    type: 'enum',
    options: [
      { value: 'low',    label: 't:enum.priority.low' },
      { value: 'medium', label: 't:enum.priority.medium' },
      { value: 'high',   label: 't:enum.priority.high' },
    ],
  },
}
```

This is handled by the Schema metadata i18n layer (react-i18next), NOT by data i18n. The `translatable` flag on an enum field would apply to a user-selectable enum value stored per record, not to the option labels themselves.

## 11. UI Components (Future — P4)

### 11.1 Translatable Input Widget

```
┌─ Product Name ─────────────────────────────────┐
│ [中文] [English] [日本語]                       │
│ ┌─────────────────────────────────────────────┐ │
│ │ 采购订单模板                                 │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

- Default locale tab marked as required
- Unfilled locale tabs show indicator dot
- Registered in widget registry as `translatable-string` / `translatable-text`

### 11.2 React Hook

```typescript
import { useTranslatableField } from '@linchkit/cap-adapter-ui-react'

function TranslatableInput({ value, onChange }) {
  const {
    currentLocale,
    currentValue,
    availableLocales,
    setLocaleValue,
    allValues,
  } = useTranslatableField(value)

  return (
    <LocaleTabs locales={availableLocales} active={currentLocale}>
      <Input
        value={currentValue}
        onChange={(v) => {
          const updated = setLocaleValue(currentLocale, v)
          onChange(updated)
        }}
      />
    </LocaleTabs>
  )
}
```

### 11.3 List Display

List views resolve translatable fields using the current UI locale (`i18n.language` from react-i18next), with fallback chain applied client-side.

## 12. Performance Considerations

### 12.1 No-JOIN Advantage

JSONB inline eliminates the primary performance concern of translation tables: no JOINs, no N+1 queries, no cross-table consistency issues.

### 12.2 JSONB Size

Typical translatable field with 3 locales:
- `{"en":"Purchase Order","zh-CN":"采购订单","ja":"購買注文"}` ≈ 80 bytes
- vs single string ≈ 20 bytes
- Overhead: ~4x per field, negligible for text content

### 12.3 Indexing

For high-traffic query patterns:
```sql
-- Fast lookup by specific locale
CREATE INDEX idx_product_name_en ON product ((name->>'en'));

-- GIN for containment queries (search across all locales)
CREATE INDEX idx_product_name_gin ON product USING GIN (name jsonb_path_ops);
```

Indexes are opt-in per schema per field, not auto-generated.

### 12.4 Caching

GraphQL response caching (via `CacheManager`) naturally handles locale because:
- Cache keys include the request locale
- Cache invalidation triggers on any write to the record (all locales invalidated together)
- No stale translation risk from separate table updates

### 12.5 DataLoader Batching

Link resolvers use DataLoader for batch fetching. Translatable resolution happens AFTER batched fetch, so it doesn't interfere with batching efficiency.

## 13. Migration Strategy

### 13.1 New Schemas

Schemas created with `translatable: true` fields generate `jsonb` columns from the start. No migration needed.

### 13.2 Adding Translatable to Existing Fields

When adding `translatable: true` to an existing `varchar`/`text` field:

1. Generate migration: `bun run db:generate`
2. Drizzle detects column type change (`varchar` → `jsonb`)
3. **Manual migration step needed**: Convert existing string values to JSONB format

```sql
-- Migration helper: wrap existing string values
UPDATE product SET name = jsonb_build_object('zh-CN', name::text)
WHERE jsonb_typeof(name::jsonb) IS NULL;
```

### 13.3 Removing Translatable

When removing `translatable: true`:
1. Decide which locale's value to keep
2. Extract that locale's value to a plain string column
3. Generate migration

### 13.4 Adding New Locales

**No migration required.** Simply start writing values with the new locale key. JSONB columns accept any key.

## 14. Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| `translatable` flag in `BaseFieldDefinition` | Done | `packages/core/src/types/schema.ts` |
| `SchemaI18nConfig` type | Done | `packages/core/src/types/schema.ts` |
| `resolveTranslatableValue()` | Done | `packages/core/src/schema/translatable.ts` |
| `normalizeTranslatableValue()` | Done | `packages/core/src/schema/translatable.ts` |
| `resolveTranslatableRow()` | Done | `packages/core/src/schema/translatable.ts` |
| `normalizeTranslatableRow()` | Done | `packages/core/src/schema/translatable.ts` |
| `validateTranslatableSchema()` | Done | `packages/core/src/schema/translatable.ts` |
| Drizzle jsonb column generation | Done | `packages/core/src/schema/schema-to-drizzle.ts` |
| GraphQL resolved field + `_i18n` suffix | Done | `cap-adapter-server/.../schema-to-graphql.ts` |
| GraphQL mutation normalization | Done | `cap-adapter-server/.../build-schema.ts` |
| GraphQL context locale | Done | `cap-adapter-server/.../build-schema.ts` |
| Unit tests | Done | `packages/core/__tests__/translatable.test.ts` |
| Integration tests | Done | `cap-adapter-server/__tests__/graphql-translatable.test.ts` |
| REST API locale support | Pending | — |
| Translation management endpoint | Pending | — |
| UI translatable widget | Pending | — |
| `useTranslatableField` hook | Pending | — |
| Search/filter for translatable fields | Pending | — |
| Expression index generation helper | Pending | — |

## 15. Open Questions

1. **Global vs per-schema `supportedLocales`**: Should `supportedLocales` come from a global system config or remain per-schema? Recommendation: Global config with per-schema override.
2. **Translation workflow**: Should translations have review states (draft, pending_review, approved)? Current answer: No (YAGNI). Revisit when enterprise customers request it.
3. **AI auto-translation**: Integration with LLM for automatic translation suggestions? Future capability — can be a separate `cap-ai-translate` capability.
4. **Full-text search**: Automatic GIN index creation for translatable fields, or always manual? Current answer: Manual (developer opt-in).
5. **Rich text translatable**: Should `text` fields with rich text (HTML/Markdown) support translatable? Yes — same JSONB approach, each locale stores the formatted text.

## 16. Implementation Phases

| Phase | Scope | Milestone |
|-------|-------|-----------|
| P1 | Type definitions + validation + Drizzle generation | **Done** |
| P2 | Action Engine normalization + resolution | **Done** |
| P3 | GraphQL `_i18n` fields + locale context | **Done** |
| P4 | UI translatable widget + `useTranslatableField` hook | M2 |
| P5 | REST locale support + translation management endpoint | M2 |
| P6 | Search/filter for translatable fields | M3 |
| P7 | Expression index generation helper | M3 |
