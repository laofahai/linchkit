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

import { NO_TENANT_SENTINEL } from "./tables";
import type {
  DeleteDocumentInput,
  SearchHit,
  SearchQueryOptions,
  SearchService,
  UpsertDocumentInput,
} from "./types";

/**
 * Normalize the optional `tenantId` from caller-facing API (undefined /
 * empty / non-empty string) into the on-disk representation:
 *   - undefined  → NO_TENANT_SENTINEL ('')
 *   - ''         → NO_TENANT_SENTINEL ('')
 *   - 'tenant-A' → 'tenant-A'
 */
function normalizeTenantId(tenantId: string | undefined): string {
  return tenantId && tenantId.length > 0 ? tenantId : NO_TENANT_SENTINEL;
}

// ── InMemorySearchService ───────────────────────────────────

interface InMemoryDoc {
  tenantId: string;
  entity: string;
  recordId: string;
  content: string;
}

export class InMemorySearchService implements SearchService {
  private docs: InMemoryDoc[] = [];

  async upsertDocument(input: UpsertDocumentInput): Promise<void> {
    const tenantId = normalizeTenantId(input.tenantId);
    this.docs = this.docs.filter(
      (d) =>
        !(d.tenantId === tenantId && d.entity === input.entity && d.recordId === input.recordId),
    );
    this.docs.push({
      tenantId,
      entity: input.entity,
      recordId: input.recordId,
      content: input.content,
    });
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    const tenantId = normalizeTenantId(input.tenantId);
    this.docs = this.docs.filter(
      (d) =>
        !(d.tenantId === tenantId && d.entity === input.entity && d.recordId === input.recordId),
    );
  }

  async search(query: string, options?: SearchQueryOptions): Promise<SearchHit[]> {
    const { tenantId: rawTenant, entity, limit = 20 } = options ?? {};
    const tenantId = normalizeTenantId(rawTenant);
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];

    // Tenant scoping mirrors DrizzleSearchService: an undefined / empty query
    // tenant matches docs with NO tenant assigned (the NO_TENANT_SENTINEL row),
    // NOT all tenants. Cross-tenant leakage requires an explicit opt-out (the
    // caller has to pass the target tenantId).
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

export class DrizzleSearchService implements SearchService {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB instance type varies by driver
  constructor(private readonly db: any) {}

  async upsertDocument(input: UpsertDocumentInput): Promise<void> {
    const { searchDocumentsTable } = await import("./tables");
    const { sql } = await import("drizzle-orm");
    const tenantId = normalizeTenantId(input.tenantId);

    // Atomic upsert via ON CONFLICT — the (tenant_id, entity, record_id)
    // unique index is the conflict target. Single statement = no inconsistent
    // intermediate state if the insert path errors, unlike the prior
    // delete+insert sequence.
    await this.db
      .insert(searchDocumentsTable)
      .values({
        tenantId,
        entity: input.entity,
        recordId: input.recordId,
        // biome-ignore lint/suspicious/noExplicitAny: tsvector custom type expects string, but value is computed via SQL
        tsv: sql`to_tsvector('simple', ${input.content})` as any,
      })
      .onConflictDoUpdate({
        target: [
          searchDocumentsTable.tenantId,
          searchDocumentsTable.entity,
          searchDocumentsTable.recordId,
        ],
        set: {
          // biome-ignore lint/suspicious/noExplicitAny: tsvector custom type expects string, but value is computed via SQL
          tsv: sql`to_tsvector('simple', ${input.content})` as any,
          updatedAt: sql`now()`,
        },
      });
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    const { searchDocumentsTable } = await import("./tables");
    const { sql, and, eq } = await import("drizzle-orm");
    const tenantId = normalizeTenantId(input.tenantId);

    await this.db
      .delete(searchDocumentsTable)
      .where(
        and(
          eq(searchDocumentsTable.tenantId, tenantId),
          eq(searchDocumentsTable.entity, input.entity),
          eq(searchDocumentsTable.recordId, input.recordId),
        ),
      );
    // sql import is intentionally kept above so the import map stays uniform;
    // even though this method doesn't currently use it directly, the symbol
    // appears in adjacent methods and the import resolution cost is shared.
    void sql;
  }

  async search(query: string, options?: SearchQueryOptions): Promise<SearchHit[]> {
    const { searchDocumentsTable } = await import("./tables");
    const { sql, and, eq } = await import("drizzle-orm");

    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const { tenantId: rawTenant, entity, limit = 20 } = options ?? {};
    const tenantId = normalizeTenantId(rawTenant);
    const safeLimit = Math.max(1, Math.min(limit, 200));

    // plainto_tsquery sanitizes user input on its own — no boolean operators
    // are interpreted, so SQL injection via the query string is not possible
    // (drizzle parameterizes the value separately from the SQL template).
    const tsQuery = sql`plainto_tsquery('simple', ${trimmed})`;

    // Build the WHERE clause imperatively — cleaner than the prior
    // sentinel-value OR pattern, and removes the (small but real) risk that
    // an entity name collides with the sentinel.
    const whereConditions = [
      sql`${searchDocumentsTable.tsv} @@ ${tsQuery}`,
      eq(searchDocumentsTable.tenantId, tenantId),
    ];
    if (entity !== undefined) {
      whereConditions.push(eq(searchDocumentsTable.entity, entity));
    }

    // biome-ignore lint/suspicious/noExplicitAny: Drizzle row type varies by driver
    const rows: any[] = await this.db
      .select({
        entity: searchDocumentsTable.entity,
        recordId: searchDocumentsTable.recordId,
        score: sql<number>`ts_rank(${searchDocumentsTable.tsv}, ${tsQuery})`.as("score"),
      })
      .from(searchDocumentsTable)
      .where(and(...whereConditions))
      .orderBy(sql`score DESC`)
      .limit(safeLimit);

    return rows.map((row) => ({
      entity: row.entity,
      recordId: row.recordId,
      score: Number(row.score) || 0,
    }));
  }
}
