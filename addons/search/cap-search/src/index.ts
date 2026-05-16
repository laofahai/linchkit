/**
 * @linchkit/cap-search — public API
 */

export type { CapSearchOptions } from "./capability";
export { capSearch, createCapSearch } from "./capability";
export { defineSearchIndex } from "./define-search-index";
export { buildSearchIndexRegistry, createSearchIndexer } from "./event-handler";
export {
  buildSearchGraphQLExtension,
  type SearchGraphQLExtension,
  type SearchGraphQLExtensionOptions,
} from "./graphql";
export { DrizzleSearchService, InMemorySearchService } from "./service";
export { searchDocumentsTable } from "./tables";
export type {
  DeleteDocumentInput,
  SearchHit,
  SearchIndexDefinition,
  SearchQueryOptions,
  SearchService,
  UpsertDocumentInput,
} from "./types";
