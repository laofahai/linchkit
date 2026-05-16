# @linchkit/cap-search

Phase 1 full-text search capability backed by PostgreSQL `tsvector` / `tsquery`.

## Status

- [x] Search-index registry (`defineSearchIndex`)
- [x] Single shared `_linchkit.search_documents` table
- [x] Event-driven indexer (record.created / updated / deleted)
- [x] Global `search(q, entity, limit)` GraphQL query, tenant-scoped
- [ ] UI search bar — follow-up
- [ ] Backfill job for existing rows — follow-up
- [ ] Ranking customization, language analyzers, boolean operators — follow-ups

## Usage

```ts
import { createCapSearch, defineSearchIndex } from "@linchkit/cap-search";

const capSearch = createCapSearch({
  db, // Drizzle PostgreSQL instance
  indexes: [
    defineSearchIndex({
      entity: "purchase_request",
      fields: ["title", "description", "vendor"],
    }),
    defineSearchIndex({
      entity: "vendor",
      fields: ["name", "contact_email"],
    }),
  ],
});
```

## GraphQL

```graphql
query {
  search(q: "office chair", entity: "purchase_request", limit: 10) {
    entity
    recordId
    score
  }
}
```

The resolver scopes results to `context.tenantId` (set by the adapter's yoga
context factory).

## Manual migration step

Drizzle-kit emits a btree index for non-standard column types. Apply this once
after the generated migration runs:

```sql
CREATE INDEX IF NOT EXISTS idx_search_documents_tsv
  ON _linchkit.search_documents USING GIN (tsv);
```

## Phase 1 limitations

- Indexes only future writes; existing rows need a separate backfill job.
- Uses the `simple` text-search config — no stemming / per-language analyzers.
- Query parser is `plainto_tsquery` — boolean operators (`&`, `|`, `!`) and
  prefix matching (`foo:*`) are not supported. Untrusted input is safe.
- Only scalar fields (string / number / boolean) on the post-update payload are
  indexed; arrays and objects are dropped silently.
