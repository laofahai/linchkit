/**
 * Entity CRUD, metadata, relations, onchange, and state transition API client.
 */

import type { RelationDefinition, SemanticRelation, StateDefinition } from "@linchkit/core/types";

import {
  type GraphQLResponse,
  getAuthHeaders,
  graphql,
  handleUnauthorized,
  toPascalCase,
} from "./api";

// ── Private helpers ─────────────────────────────────────

function toCamelCase(name: string): string {
  const parts = name.split(/[_-]/);
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("")
  );
}

function throwOnErrors(res: GraphQLResponse): void {
  const errors = res.errors;
  if (errors && errors.length > 0) {
    const firstError = errors.at(0);
    throw new Error(firstError?.message ?? "Unknown GraphQL error");
  }
}

// ── Typed query helpers ─────────────────────────────────

export interface ListQueryOptions {
  schema: string;
  filter?: Record<string, unknown>;
  /** Full-text search keyword (server-side ILIKE across string fields) */
  search?: string;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  fields: string[];
}

export interface ListResult<T = Record<string, unknown>> {
  items: T[];
  total: number;
}

/**
 * Query a paginated list via GraphQL.
 */
export async function queryList<T = Record<string, unknown>>(
  options: ListQueryOptions,
): Promise<ListResult<T>> {
  const queryName = `${toCamelCase(options.schema)}List`;
  const fieldList = options.fields.join(" ");

  const query = `
    query ($filter: String, $search: String, $sortField: String, $sortOrder: String, $page: Int, $pageSize: Int) {
      ${queryName}(filter: $filter, search: $search, sortField: $sortField, sortOrder: $sortOrder, page: $page, pageSize: $pageSize) {
        items { ${fieldList} }
        total
      }
    }
  `;

  const variables: Record<string, unknown> = {
    sortField: options.sortField,
    sortOrder: options.sortOrder,
    page: options.page,
    pageSize: options.pageSize,
  };
  if (options.search) {
    variables.search = options.search;
  }
  if (options.filter && Object.keys(options.filter).length > 0) {
    variables.filter = JSON.stringify(options.filter);
  }

  const res = await graphql<Record<string, ListResult<T>>>(query, variables);
  throwOnErrors(res);
  return res.data?.[queryName] ?? { items: [], total: 0 };
}

/**
 * Query a single record by ID via GraphQL.
 */
export async function queryRecord<T = Record<string, unknown>>(
  schema: string,
  id: string,
  fields: string[],
): Promise<T | null> {
  const queryName = toCamelCase(schema);
  const fieldList = fields.join(" ");

  const query = `
    query ($id: ID!) {
      ${queryName}(id: $id) { ${fieldList} }
    }
  `;

  const res = await graphql<Record<string, T | null>>(query, { id });
  throwOnErrors(res);
  return res.data?.[queryName] ?? null;
}

// ── Mutations ───────────────────────────────────────────

/**
 * Create a record via GraphQL mutation.
 */
export async function createRecord<T = Record<string, unknown>>(
  schema: string,
  input: Record<string, unknown>,
  fields: string[],
): Promise<T> {
  const mutationName = `create${toPascalCase(schema)}`;
  const fieldList = fields.join(" ");

  const query = `
    mutation ($input: ${toPascalCase(schema)}Input!) {
      ${mutationName}(input: $input) { ${fieldList} }
    }
  `;

  const res = await graphql<Record<string, T>>(query, { input });
  throwOnErrors(res);
  const result = res.data?.[mutationName];
  if (result === undefined) throw new Error("No data returned");
  return result;
}

/**
 * Update a record via GraphQL mutation.
 */
export async function updateRecord<T = Record<string, unknown>>(
  schema: string,
  id: string,
  input: Record<string, unknown>,
  fields: string[],
): Promise<T> {
  const mutationName = `update${toPascalCase(schema)}`;
  const fieldList = fields.join(" ");

  const query = `
    mutation ($id: ID!, $input: ${toPascalCase(schema)}Input!) {
      ${mutationName}(id: $id, input: $input) { ${fieldList} }
    }
  `;

  const res = await graphql<Record<string, T>>(query, { id, input });
  throwOnErrors(res);
  const result = res.data?.[mutationName];
  if (result === undefined) throw new Error("No data returned");
  return result;
}

/**
 * Delete a record via GraphQL mutation.
 */
export async function deleteRecord(schema: string, id: string): Promise<boolean> {
  const mutationName = `delete${toPascalCase(schema)}`;

  const query = `
    mutation ($id: ID!) {
      ${mutationName}(id: $id)
    }
  `;

  const res = await graphql<Record<string, boolean>>(query, { id });
  throwOnErrors(res);
  const result = res.data?.[mutationName];
  if (result === undefined) throw new Error("No data returned");
  return result;
}

/**
 * Delete multiple records in parallel via GraphQL mutations.
 * Returns an object with counts of succeeded and failed deletions.
 */
export async function bulkDeleteRecords(
  schema: string,
  ids: string[],
): Promise<{ succeeded: number; failed: number; errors: string[] }> {
  const results = await Promise.allSettled(ids.map((id) => deleteRecord(schema, id)));
  const errors: string[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value) {
        succeeded++;
      } else {
        failed++;
        errors.push("Delete mutation returned false");
      }
    } else {
      failed++;
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }
  return { succeeded, failed, errors };
}

// ── Entity metadata ─────────────────────────────────────

/** Lightweight entity info for navigation (from GET /api/entities) */
export interface EntityInfo {
  name: string;
  label?: string;
  description?: string;
  /** Lucide icon name from entity presentation config */
  icon?: string;
  /** True for system-internal entities (read-only, managed by core) */
  internal?: boolean;
}

/** @deprecated Use EntityInfo instead */
export type SchemaInfo = EntityInfo;

/** Full entity bundle with views (from GET /api/entities/:name) */
export interface EntityBundle {
  name: string;
  label?: string;
  description?: string;
  fields: Record<string, unknown>;
  presentation?: Record<string, unknown>;
  views: Record<string, unknown>;
  states?: StateDefinition[];
  relations?: RelationDefinition[];
  /** True for system-internal entities (read-only, managed by core) */
  internal?: boolean;
}

/** @deprecated Use EntityBundle instead */
export type SchemaBundle = EntityBundle;

/**
 * Fetch all registered entities from the server (lightweight list).
 */
export async function fetchEntities(): Promise<EntityInfo[]> {
  const res = await fetch("/api/entities", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error(`Failed to fetch entities: ${res.statusText}`);
  }
  const json = await res.json();
  return json.data ?? [];
}

/** @deprecated Use fetchEntities instead */
export const fetchSchemas = fetchEntities;

/**
 * Fetch a full entity bundle (entity + views) by name.
 */
export async function fetchEntityBundle(name: string): Promise<EntityBundle | null> {
  const res = await fetch(`/api/entities/${name}`, { headers: getAuthHeaders() });
  handleUnauthorized(res);
  if (!res.ok) return null;
  const json = await res.json();
  return json.data ?? null;
}

/** @deprecated Use fetchEntityBundle instead */
export const fetchSchemaBundle = fetchEntityBundle;

/**
 * Fetch all registered relation definitions from the server.
 */
export async function fetchRelations(): Promise<RelationDefinition[]> {
  const res = await fetch("/api/relations", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error(`Failed to fetch relations: ${res.statusText}`);
  }
  const json = await res.json();
  return json.data ?? [];
}

/**
 * Fetch inferred semantic relations from the server.
 */
export async function fetchSemanticRelations(): Promise<SemanticRelation[]> {
  const res = await fetch("/api/semantic-relations", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error(`Failed to fetch semantic relations: ${res.statusText}`);
  }
  const json = await res.json();
  return json.data ?? [];
}

// ── Entity onchange (Spec 64) ───────────────────────────

/** Result returned by `POST /api/entities/:name/onchange`. */
export interface EntityOnchangeResult {
  /** Field values the UI should apply to the unsaved form state. */
  updates: Record<string, unknown>;
  /** Optional non-blocking warnings to surface alongside the form. */
  warnings?: string[];
}

/**
 * Call the per-entity onchange endpoint. Returns the suggested form updates the
 * UI should apply on top of `values`. Throws on HTTP / shape errors so callers
 * can isolate transport failures from application warnings.
 *
 * Pass an `AbortSignal` (or `signal: undefined` to skip) so the caller can
 * cancel stale requests when the user keeps typing — Spec 64 §6.1 race
 * protection.
 */
export async function requestEntityOnchange(params: {
  entity: string;
  changedField: string;
  values: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<EntityOnchangeResult> {
  const { entity, changedField, values, signal } = params;
  const res = await fetch(`/api/entities/${encodeURIComponent(entity)}/onchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ changedField, values }),
    signal,
  });
  handleUnauthorized(res);
  if (!res.ok) {
    let message = `Onchange request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body === "object") {
        const error = (body as { error?: { message?: string } }).error;
        if (error?.message) message = error.message;
      }
    } catch {
      // Body was not JSON — keep default message.
    }
    throw new Error(message);
  }
  const json = (await res.json()) as Partial<EntityOnchangeResult> | null;
  return {
    updates:
      json && typeof json === "object" && json.updates && typeof json.updates === "object"
        ? (json.updates as Record<string, unknown>)
        : {},
    warnings: Array.isArray(json?.warnings) ? json.warnings : undefined,
  };
}

// ── State Transitions ───────────────────────────────────

export interface AvailableTransition {
  from: string;
  to: string;
  action: string;
  allowed: boolean;
  reason?: string | null;
}

/**
 * Query available state transitions for a record via GraphQL.
 */
export async function queryAvailableTransitions(
  schema: string,
  id: string,
): Promise<AvailableTransition[]> {
  const queryName = `${toCamelCase(schema)}AvailableTransitions`;
  const query = `
    query ($id: ID!) {
      ${queryName}(id: $id) { from to action allowed reason }
    }
  `;
  const res = await graphql<Record<string, AvailableTransition[]>>(query, { id });
  throwOnErrors(res);
  return res.data?.[queryName] ?? [];
}

/**
 * Execute a state transition via GraphQL mutation.
 */
export async function transitionRecord<T = Record<string, unknown>>(
  schema: string,
  id: string,
  to: string,
  fields: string[],
): Promise<T> {
  const mutationName = `transition${toPascalCase(schema)}`;
  const fieldList = fields.join(" ");
  const query = `
    mutation ($id: ID!, $to: String!) {
      ${mutationName}(id: $id, to: $to) { ${fieldList} }
    }
  `;
  const res = await graphql<Record<string, T>>(query, { id, to });
  throwOnErrors(res);
  const result = res.data?.[mutationName];
  if (result === undefined) throw new Error("No data returned");
  return result;
}

// ── State Transition History ────────────────────────────

export interface StateTransitionEntry {
  from: string;
  to: string;
  action: string;
  actorId: string;
  startedAt: string;
}

/**
 * Query state transition history for a specific record.
 * Returns execution log entries that have state_transition data,
 * ordered by time ascending (oldest first).
 */
export async function queryStateTransitions(
  entityName: string,
  recordId: string,
): Promise<StateTransitionEntry[]> {
  const filter = JSON.stringify({ entity_name: entityName, record_id: recordId });
  const query = `
    query ($filter: String) {
      executionLogList(filter: $filter, pageSize: 50, sortField: "started_at", sortOrder: "asc") {
        items {
          action_name actor_id started_at
          state_transition_from state_transition_to
        }
      }
    }
  `;
  const res = await graphql<{
    executionLogList: {
      items: Array<Record<string, unknown>>;
    };
  }>(query, { filter });
  throwOnErrors(res);
  const items = res.data?.executionLogList?.items ?? [];
  // Only return entries that have state transition data
  return items
    .filter((r) => r.state_transition_to)
    .map((r) => ({
      from: (r.state_transition_from as string) ?? "",
      to: r.state_transition_to as string,
      action: r.action_name as string,
      actorId: (r.actor_id as string) ?? "system",
      startedAt: r.started_at as string,
    }));
}
