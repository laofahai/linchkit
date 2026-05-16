/**
 * SearchService — document upsert/delete + full-text search.
 *
 * Two implementations:
 * - InMemorySearchService: case-insensitive substring match, used in tests and
 *   non-DB environments.
 * - DrizzleSearchService: PostgreSQL `tsvector` + `plainto_tsquery` with
 *   `ts_rank` ordering. Phase 1 uses the `simple` text-search config so no
 *   per-language analyzer setup is required.
 */

import type {
  DeleteDocumentInput,
  SearchHit,
  SearchQueryOptions,
  SearchService,
  UpsertDocumentInput,
} from "./types";

// ── InMemorySearchService ───────────────────────────────────

interface InMemoryDoc {
  tenantId?: string;
  entity: string;
  recordId: string;
  content: string;
}

export class InMemorySearchService implements SearchService {
  private docs: InMemoryDoc[] = [];

  async upsertDocument(input: UpsertDocumentInput): Promise<void> {
    this.docs = this.docs.filter(
      (d) =>
        !(
          d.tenantId === input.tenantId &&
          d.entity === input.entity &&
          d.recordId === input.recordId
        ),
    );
    this.docs.push({
      tenantId: input.tenantId,
      entity: input.entity,
      recordId: input.recordId,
      content: input.content,
    });
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    this.docs = this.docs.filter(
      (d) =>
        !(
          d.tenantId === input.tenantId &&
          d.entity === input.entity &&
          d.recordId === input.recordId
        ),
    );
  }

  async search(query: string, options?: SearchQueryOptions): Promise<SearchHit[]> {
    const { tenantId, entity, limit = 20 } = options ?? {};
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];

    // Tenant scoping mirrors DrizzleSearchService: an undefined query tenant
    // matches docs with NO tenant assigned, NOT all tenants. This is the safe
    // default — cross-tenant leakage requires an explicit opt-out (passing the
    // target tenantId) rather than an accidental `undefined`.
    const matches = this.docs
      .filter((d) => d.tenantId === tenantId)
      .filter((d) => (entity === undefined ? true : d.entity === entity))
      .filter((d) => d.content.toLowerCase().includes(needle))
      .map((d) => ({
        entity: d.entity,
        recordId: d.recordId,
        score: 0,
      }));

    return matches.slice(0, limit);
  }

  /** Test helper: drop all indexed documents */
  clear(): void {
    this.docs = [];
  }

  /** Test helper: count of indexed documents */
  size(): number {
    return this.docs.length;
  }
}

// ── DrizzleSearchService ────────────────────────────────────

const PLACEHOLDER_TENANT = "__no_tenant__";

export class DrizzleSearchService implements SearchService {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB instance type varies by driver
  constructor(private readonly db: any) {}

  async upsertDocument(input: UpsertDocumentInput): Promise<void> {
    const { searchDocumentsTable } = await import("./tables");
    const { sql } = await import("drizzle-orm");

    // Postgres treats NULL as distinct in unique indexes, so we cannot rely on
    // ON CONFLICT(tenant_id, entity, record_id) when tenant_id is NULL.
    // Strategy: delete then insert, wrapped implicitly by the surrounding
    // request transaction (or run as two statements when not transactional —
    // Phase 1 accepts the small race window).
    await this.db.delete(searchDocumentsTable).where(
      sql`${searchDocumentsTable.tenantId} IS NOT DISTINCT FROM ${input.tenantId ?? null}
            AND ${searchDocumentsTable.entity} = ${input.entity}
            AND ${searchDocumentsTable.recordId} = ${input.recordId}`,
    );

    await this.db.insert(searchDocumentsTable).values({
      tenantId: input.tenantId,
      entity: input.entity,
      recordId: input.recordId,
      // biome-ignore lint/suspicious/noExplicitAny: tsvector custom type expects string, but value is computed via SQL
      tsv: sql`to_tsvector('simple', ${input.content})` as any,
    });
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    const { searchDocumentsTable } = await import("./tables");
    const { sql } = await import("drizzle-orm");

    await this.db.delete(searchDocumentsTable).where(
      sql`${searchDocumentsTable.tenantId} IS NOT DISTINCT FROM ${input.tenantId ?? null}
            AND ${searchDocumentsTable.entity} = ${input.entity}
            AND ${searchDocumentsTable.recordId} = ${input.recordId}`,
    );
  }

  async search(query: string, options?: SearchQueryOptions): Promise<SearchHit[]> {
    const { searchDocumentsTable } = await import("./tables");
    const { sql } = await import("drizzle-orm");

    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const { tenantId, entity, limit = 20 } = options ?? {};
    const safeLimit = Math.max(1, Math.min(limit, 200));

    // plainto_tsquery sanitizes user input on its own — no boolean operators
    // are interpreted, so SQL injection via the query string is not possible
    // (drizzle parameterizes the value separately from the SQL template).
    const tsQuery = sql`plainto_tsquery('simple', ${trimmed})`;

    // biome-ignore lint/suspicious/noExplicitAny: Drizzle row type varies by driver
    const rows: any[] = await this.db
      .select({
        entity: searchDocumentsTable.entity,
        recordId: searchDocumentsTable.recordId,
        score: sql<number>`ts_rank(${searchDocumentsTable.tsv}, ${tsQuery})`.as("score"),
      })
      .from(searchDocumentsTable)
      .where(
        sql`${searchDocumentsTable.tsv} @@ ${tsQuery}
            AND ${searchDocumentsTable.tenantId} IS NOT DISTINCT FROM ${tenantId ?? null}
            AND (${entity ?? PLACEHOLDER_TENANT} = ${PLACEHOLDER_TENANT}
                 OR ${searchDocumentsTable.entity} = ${entity ?? PLACEHOLDER_TENANT})`,
      )
      .orderBy(sql`score DESC`)
      .limit(safeLimit);

    return rows.map((row) => ({
      entity: row.entity,
      recordId: row.recordId,
      score: Number(row.score) || 0,
    }));
  }
}
