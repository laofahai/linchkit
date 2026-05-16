/**
 * cap-search GraphQL extension.
 *
 * Registers a single global query:
 *   search(q: String!, entity: String, limit: Int = 20): [SearchHit!]!
 *
 * Tenant scoping: the resolver reads `context.tenantId` (set by the adapter's
 * yoga context factory) and forwards it to the SearchService so cross-tenant
 * leakage is impossible. When no tenant is in context, results are scoped to
 * the unscoped (`tenant_id IS NULL`) bucket.
 */

import type { GraphQLFieldConfig, GraphQLResolveInfo } from "graphql";
import {
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import type { SearchService } from "./types";

// ── GraphQL types ───────────────────────────────────────────

const SearchHitType = new GraphQLObjectType({
  name: "SearchHit",
  description: "A single full-text search result.",
  fields: {
    entity: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'snake_case entity name (e.g. "purchase_request")',
    },
    recordId: {
      type: new GraphQLNonNull(GraphQLString),
      description: "Primary key of the matching record",
    },
    score: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: "PostgreSQL ts_rank score (higher = better match)",
    },
  },
});

// ── Resolver context shape ──────────────────────────────────

interface SearchResolverContext {
  tenantId?: string;
}

// ── Extension builder ───────────────────────────────────────

export interface SearchGraphQLExtensionOptions {
  service: SearchService;
}

export interface SearchGraphQLExtension {
  types: GraphQLObjectType[];
  queryFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
}

export function buildSearchGraphQLExtension(
  options: SearchGraphQLExtensionOptions,
): SearchGraphQLExtension {
  const { service } = options;

  const searchField: GraphQLFieldConfig<unknown, unknown> = {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SearchHitType))),
    description:
      "Full-text search across all entities with a registered defineSearchIndex. " +
      "Tenant-scoped via the request context.",
    args: {
      q: {
        type: new GraphQLNonNull(GraphQLString),
        description: "Free-text query (parsed via PostgreSQL plainto_tsquery)",
      },
      entity: {
        type: GraphQLString,
        description: "Optional entity filter (snake_case name)",
      },
      limit: {
        type: GraphQLInt,
        defaultValue: 20,
        description: "Maximum hits to return (1-200, default 20)",
      },
    },
    resolve: async (
      _source: unknown,
      args: { q: string; entity?: string; limit?: number },
      context: unknown,
      _info: GraphQLResolveInfo,
    ) => {
      const ctx = (context ?? {}) as SearchResolverContext;
      const hits = await service.search(args.q, {
        tenantId: ctx.tenantId,
        entity: args.entity,
        limit: args.limit,
      });
      return hits;
    },
  };

  return {
    types: [SearchHitType],
    queryFields: { search: searchField },
  };
}
