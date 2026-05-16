/**
 * cap-search type definitions
 */

// ── Search index registration ───────────────────────────────

/**
 * A search-index registration produced by `defineSearchIndex()`.
 * Capabilities register one per entity they want full-text indexed.
 */
export interface SearchIndexDefinition {
  /** snake_case entity name (e.g. "purchase_request") */
  entity: string;
  /** Field names whose values should be concatenated into the document */
  fields: string[];
}

// ── Search hit ──────────────────────────────────────────────

export interface SearchHit {
  entity: string;
  recordId: string;
  /** PostgreSQL ts_rank score; 0 for in-memory fallback */
  score: number;
}

// ── Indexer input / service contract ────────────────────────

export interface UpsertDocumentInput {
  tenantId?: string;
  entity: string;
  recordId: string;
  /** Concatenated text used to build the tsvector */
  content: string;
}

export interface DeleteDocumentInput {
  tenantId?: string;
  entity: string;
  recordId: string;
}

export interface SearchQueryOptions {
  /** Optional tenant scope (results outside this tenant are excluded) */
  tenantId?: string;
  /** Optional entity filter (snake_case name) */
  entity?: string;
  /** Max hits to return (default 20) */
  limit?: number;
}

export interface SearchService {
  upsertDocument(input: UpsertDocumentInput): Promise<void>;
  deleteDocument(input: DeleteDocumentInput): Promise<void>;
  search(query: string, options?: SearchQueryOptions): Promise<SearchHit[]>;
}
