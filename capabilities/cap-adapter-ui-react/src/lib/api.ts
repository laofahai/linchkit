/**
 * API client for LinchKit server.
 *
 * Provides GraphQL query/mutation helpers and REST action execution.
 * Uses plain fetch — no external GraphQL client library needed.
 */

import { getTenantHeaders } from "./tenant";

// ── Auth header helper ──────────────────────────────────

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("linchkit:token");
  const tenantHeaders = getTenantHeaders();
  if (token) {
    return { Authorization: `Bearer ${token}`, ...tenantHeaders };
  }
  return { ...tenantHeaders };
}

function handleUnauthorized(res: Response): void {
  if (res.status === 401) {
    localStorage.removeItem("linchkit:token");
    localStorage.removeItem("linchkit:authenticated");
    // Only redirect to login if auth capability is loaded
    if (isAuthEnabled()) {
      window.location.href = "/login";
    }
  }
}

// ── GraphQL ─────────────────────────────────────────────

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: { message: string; locations?: unknown[]; path?: string[] }[];
}

/**
 * Execute a GraphQL query or mutation.
 */
export async function graphql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const res = await fetch("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  handleUnauthorized(res);
  return res.json();
}

/** Throw if a GraphQL response contains errors. */
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
 * Convert snake_case schema name to camelCase for GraphQL query names.
 */
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

/**
 * Query a paginated list via GraphQL.
 */
export async function queryList<T = Record<string, unknown>>(
  options: ListQueryOptions,
): Promise<ListResult<T>> {
  const queryName = `${toCamelCase(options.schema)}List`;
  const fieldList = options.fields.join(" ");

  const query = `
    query ($filter: String, $sortField: String, $sortOrder: String, $page: Int, $pageSize: Int) {
      ${queryName}(filter: $filter, sortField: $sortField, sortOrder: $sortOrder, page: $page, pageSize: $pageSize) {
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

function toPascalCase(name: string): string {
  return name
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

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
      succeeded++;
    } else {
      failed++;
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }
  return { succeeded, failed, errors };
}

// ── App config ──────────────────────────────────────────

/** Application config returned by GET /api/app-config */
export interface AppConfig {
  authEnabled: boolean;
  aiEnabled: boolean;
  capabilities: string[];
  pages: Array<{
    name: string;
    path: string;
    label?: string;
    layout: string;
    auth: string;
    redirectOnFail?: string;
    component: string;
    props?: Record<string, unknown>;
    order?: number;
    showInNav?: boolean;
  }>;
}

let cachedAppConfig: AppConfig | null = null;

/**
 * Fetch app config from the server.
 * Returns cached result after first successful fetch.
 */
export async function fetchAppConfig(): Promise<AppConfig> {
  if (cachedAppConfig) return cachedAppConfig;
  try {
    const res = await fetch("/api/app-config");
    const json = await res.json();
    cachedAppConfig = json.data ?? { authEnabled: false, aiEnabled: false, capabilities: [], pages: [] };
  } catch {
    // If server is unreachable, assume no auth (graceful degradation)
    cachedAppConfig = { authEnabled: false, aiEnabled: false, capabilities: [], pages: [] };
  }
  return cachedAppConfig as AppConfig;
}

/**
 * Check whether auth is enabled. Uses cached config when available,
 * otherwise returns false (safe default for initial page load).
 */
export function isAuthEnabled(): boolean {
  return cachedAppConfig?.authEnabled ?? false;
}

/**
 * Check whether AI service is enabled. Uses cached config when available,
 * otherwise returns false (safe default for initial page load).
 */
export function isAiEnabled(): boolean {
  return cachedAppConfig?.aiEnabled ?? false;
}

// ── AI Auto-Fill ────────────────────────────────────────

/** Single AI suggestion for a field */
export interface AiFieldSuggestion {
  value: unknown;
  confidence: number;
  reason?: string;
}

/** Response from the AI auto-fill endpoint */
export interface AiAutoFillResult {
  suggestions: Record<string, AiFieldSuggestion>;
}

/**
 * Request AI-powered auto-fill suggestions for empty form fields.
 */
export async function requestAiAutoFill(params: {
  schema: string;
  fields: Record<string, { label?: string; type?: string; required?: boolean; options?: string[]; description?: string }>;
  currentValues: Record<string, unknown>;
}): Promise<AiAutoFillResult> {
  const res = await fetch("/api/ai/auto-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(params),
  });
  handleUnauthorized(res);
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message ?? "AI auto-fill failed");
  }
  return json.data ?? { suggestions: {} };
}

// ── Schema metadata ─────────────────────────────────────

/** Lightweight schema info for navigation (from GET /api/schemas) */
export interface SchemaInfo {
  name: string;
  label?: string;
  description?: string;
  /** Lucide icon name from schema presentation config */
  icon?: string;
}

import type { LinkDefinition, StateDefinition } from "@linchkit/core/types";

/** Full schema bundle with views (from GET /api/schemas/:name) */
export interface SchemaBundle {
  name: string;
  label?: string;
  description?: string;
  fields: Record<string, unknown>;
  presentation?: Record<string, unknown>;
  views: Record<string, unknown>;
  states?: StateDefinition[];
  links?: LinkDefinition[];
}

/**
 * Fetch all registered schemas from the server (lightweight list).
 */
export async function fetchSchemas(): Promise<SchemaInfo[]> {
  const res = await fetch("/api/schemas", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data ?? [];
}

/**
 * Fetch a full schema bundle (schema + views) by name.
 */
export async function fetchSchemaBundle(name: string): Promise<SchemaBundle | null> {
  const res = await fetch(`/api/schemas/${name}`, { headers: getAuthHeaders() });
  handleUnauthorized(res);
  if (!res.ok) return null;
  const json = await res.json();
  return json.data ?? null;
}

// ── REST Action execution ───────────────────────────────

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  meta?: { executionId?: string };
}

/**
 * Execute a named action via REST API.
 */
export async function executeAction(
  actionName: string,
  input: Record<string, unknown>,
): Promise<ActionResult> {
  const res = await fetch(`/api/actions/${actionName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(input),
  });
  if (actionName !== "login") handleUnauthorized(res);
  return res.json();
}

// ── State Transitions ───────────────────────────────────

export interface AvailableTransition {
  from: string;
  to: string;
  action: string;
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
      ${queryName}(id: $id) { from to action }
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

// ── AI Search ───────────────────────────────────────────

export interface AISearchRequest {
  query: string;
  schema: string;
  fields: Record<string, { label?: string; type?: string; options?: string[] }>;
}

export interface AISearchResult {
  filter: Record<string, unknown>;
  explanation: string;
}

/**
 * Send a natural language query to the AI search endpoint.
 * Returns a DeclarativeCondition filter or null if AI is not configured.
 */
export async function aiSearch(request: AISearchRequest): Promise<AISearchResult | null> {
  const res = await fetch("/api/ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(request),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error("AI search request failed");
  }
  const json = await res.json();
  return json.data ?? null;
}

// ── Execution Logs ──────────────────────────────────────

export interface ExecutionLogEntry {
  id: string;
  action: string;
  schema?: string;
  recordId?: string;
  actor: { type: string; id: string };
  input?: string;
  output?: string;
  status: "succeeded" | "failed" | "blocked" | "pending_approval";
  error?: { code?: string; message: string };
  stateTransition?: { from: string; to: string };
  duration: number;
  startedAt: string;
  completedAt: string;
}

export interface ExecutionLogListResult {
  items: ExecutionLogEntry[];
  total: number;
}

/**
 * Query execution logs for a specific schema/record via GraphQL.
 */
export async function queryExecutionLogs(
  options: {
    schema?: string;
    page?: number;
    pageSize?: number;
  },
): Promise<ExecutionLogListResult> {
  const query = `
    query ($schema: String, $page: Int, $pageSize: Int) {
      executionLogs(schema: $schema, page: $page, pageSize: $pageSize, sortField: "startedAt", sortOrder: "desc") {
        items {
          id action schema recordId
          actor { type id }
          input
          status duration startedAt completedAt
          error { code message }
          stateTransition { from to }
        }
        total
      }
    }
  `;
  const res = await graphql<{ executionLogs: ExecutionLogListResult }>(query, {
    schema: options.schema,
    page: options.page,
    pageSize: options.pageSize,
  });
  throwOnErrors(res);
  return res.data?.executionLogs ?? { items: [], total: 0 };
}
