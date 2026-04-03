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

/** Menu item registered by a capability */
export interface MenuItemConfig {
  id: string;
  label: string;
  path: string;
  icon?: string;
  section?: "main" | "admin";
  order?: number;
  auth?: "required" | "anonymous" | "optional";
}

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
  menuItems?: MenuItemConfig[];
}

let cachedAppConfig: AppConfig | null = null;

/**
 * Fetch app config from the server.
 * Only caches on successful fetch — errors are not cached so the next
 * page load will retry (prevents permanent empty menus after startup glitch).
 */
export async function fetchAppConfig(): Promise<AppConfig> {
  if (cachedAppConfig) return cachedAppConfig;
  const fallback: AppConfig = {
    authEnabled: false,
    aiEnabled: false,
    capabilities: [],
    pages: [],
    menuItems: [],
  };
  try {
    const res = await fetch("/api/app-config");
    const json = await res.json();
    if (json.data) {
      cachedAppConfig = json.data;
      return cachedAppConfig as AppConfig;
    }
    // Server responded but returned no data — don't cache, return fallback
    return fallback;
  } catch {
    // Server unreachable — return fallback without caching so next load retries
    return fallback;
  }
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

/**
 * Get registered menu items from cached app config.
 * Returns empty array before config is fetched.
 */
export function getMenuItems(): MenuItemConfig[] {
  return cachedAppConfig?.menuItems ?? [];
}

/**
 * Get active capability names from cached app config.
 * Returns empty array before config is fetched.
 */
export function getActiveCapabilities(): string[] {
  return cachedAppConfig?.capabilities ?? [];
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
  fields: Record<
    string,
    { label?: string; type?: string; required?: boolean; options?: string[]; description?: string }
  >;
  currentValues: Record<string, unknown>;
  locale?: string;
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
  /** True for system-internal schemas (read-only, managed by core) */
  internal?: boolean;
}

import type { LinkDefinition, SemanticRelation, StateDefinition } from "@linchkit/core/types";

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
  /** True for system-internal schemas (read-only, managed by core) */
  internal?: boolean;
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

/**
 * Fetch all registered link definitions from the server.
 */
export async function fetchLinks(): Promise<LinkDefinition[]> {
  const res = await fetch("/api/links", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data ?? [];
}

/**
 * Fetch inferred semantic relations from the server.
 */
export async function fetchSemanticRelations(): Promise<SemanticRelation[]> {
  const res = await fetch("/api/semantic-relations", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data ?? [];
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

// ── AI Search ───────────────────────────────────────────

export interface AISearchRequest {
  query: string;
  schema: string;
  fields: Record<string, { label?: string; type?: string; options?: string[] }>;
  locale?: string;
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

// ── AI Intent Resolution ────────────────────────────────

/** Field schema info returned from intent resolution */
export interface IntentFieldSchema {
  type: string;
  label?: string;
  required: boolean;
  options?: Array<{ value: string; label?: string }>;
  description?: string;
}

/** Result from AI intent resolution */
export interface IntentResolution {
  action: string;
  schema: string;
  input: Record<string, unknown>;
  missingFields: string[];
  confidence: number;
  explanation: string;
  actionLabel: string;
  actionDescription?: string;
  inputSchema: Record<string, IntentFieldSchema>;
}

/**
 * Resolve a natural language message to an action intent.
 * Returns null if AI is not configured or no intent could be resolved.
 */
export async function resolveIntent(
  message: string,
  context: { schema?: string; recordId?: string },
): Promise<IntentResolution | null> {
  const res = await fetch("/api/ai/resolve-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ message, context }),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error("AI intent resolution failed");
  }
  const json = await res.json();
  return json.data ?? null;
}

// ── Chatter ──────────────────────────────────────────────

export interface ChatterMessageAuthor {
  id: string;
  type: string; // 'user' | 'system' | 'ai'
  name?: string | null;
}

export type ChatterMessageType = "comment" | "note" | "log" | "ai";

export interface ChatterMessage {
  id: string;
  schemaName: string;
  recordId: string;
  messageType: ChatterMessageType;
  body: string;
  author: ChatterMessageAuthor;
  logEvent?: string | null;
  logMetadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatterMessageConnection {
  items: ChatterMessage[];
  totalCount: number;
  hasMore: boolean;
}

const CHATTER_MESSAGE_FIELDS = `
  id schemaName recordId messageType body
  author { id type name }
  logEvent logMetadata
  createdAt updatedAt
`;

/**
 * Query chatter messages for a record.
 * Returns empty connection gracefully when cap-chatter is not installed.
 */
export async function queryChatterMessages(
  schemaName: string,
  recordId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ChatterMessageConnection> {
  const query = `
    query ChatterMessages($schemaName: String!, $recordId: String!, $limit: Int, $offset: Int) {
      chatterMessages(schemaName: $schemaName, recordId: $recordId, limit: $limit, offset: $offset) {
        items { ${CHATTER_MESSAGE_FIELDS} }
        totalCount
        hasMore
      }
    }
  `;
  const res = await graphql<{ chatterMessages: ChatterMessageConnection }>(query, {
    schemaName,
    recordId,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
  });
  // Graceful fallback: if cap-chatter not installed, return empty
  if (res.errors && res.errors.length > 0) {
    return { items: [], totalCount: 0, hasMore: false };
  }
  return res.data?.chatterMessages ?? { items: [], totalCount: 0, hasMore: false };
}

/**
 * Post a comment or note to a record's chatter timeline.
 */
export async function addChatterMessage(
  schemaName: string,
  recordId: string,
  messageType: "comment" | "note",
  body: string,
): Promise<ChatterMessage> {
  const query = `
    mutation AddChatterMessage($schemaName: String!, $recordId: String!, $messageType: MessageType!, $body: String!) {
      chatterAddMessage(schemaName: $schemaName, recordId: $recordId, messageType: $messageType, body: $body) {
        ${CHATTER_MESSAGE_FIELDS}
      }
    }
  `;
  const res = await graphql<{ chatterAddMessage: ChatterMessage }>(query, {
    schemaName,
    recordId,
    messageType,
    body,
  });
  throwOnErrors(res);
  const result = res.data?.chatterAddMessage;
  if (!result) throw new Error("No data returned");
  return result;
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
 * Uses the auto-generated executionLogList query with standard filter/sort/pagination.
 */
export async function queryExecutionLogs(options: {
  schema?: string;
  page?: number;
  pageSize?: number;
}): Promise<ExecutionLogListResult> {
  const filter = options.schema ? JSON.stringify({ schema_name: options.schema }) : undefined;
  const query = `
    query ($filter: String, $page: Int, $pageSize: Int) {
      executionLogList(filter: $filter, page: $page, pageSize: $pageSize, sortField: "started_at", sortOrder: "desc") {
        items {
          id action_name schema_name record_id
          actor_id actor_type
          input
          status duration_ms started_at completed_at
          error_code error_message
        }
        total
      }
    }
  `;
  const res = await graphql<{
    executionLogList: {
      items: Array<Record<string, unknown>>;
      total: number;
    };
  }>(query, {
    filter,
    page: options.page,
    pageSize: options.pageSize,
  });
  throwOnErrors(res);
  const raw = res.data?.executionLogList ?? { items: [], total: 0 };
  // Map snake_case system schema fields to camelCase UI interface
  const items: ExecutionLogEntry[] = raw.items.map((r) => ({
    id: r.id as string,
    action: r.action_name as string,
    schema: r.schema_name as string | undefined,
    recordId: r.record_id as string | undefined,
    actor: { type: (r.actor_type as string) ?? "system", id: (r.actor_id as string) ?? "unknown" },
    input: typeof r.input === "object" ? JSON.stringify(r.input) : (r.input as string | undefined),
    status: r.status as ExecutionLogEntry["status"],
    error:
      r.error_code || r.error_message
        ? { code: r.error_code as string | undefined, message: (r.error_message as string) ?? "" }
        : undefined,
    duration: (r.duration_ms as number) ?? 0,
    startedAt: r.started_at as string,
    completedAt: r.completed_at as string,
  }));
  return { items, total: raw.total };
}

// ── Runtime Config API ──────────────────────────────────

export interface ConfigFieldDef {
  type: "string" | "number" | "boolean" | "json";
  label?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  secret?: boolean;
  validation?: { min?: number; max?: number; pattern?: string };
}

export interface ConfigItem {
  name: string;
  schema: string;
  label?: string;
  fields: Record<string, ConfigFieldDef>;
  values: Record<string, unknown>;
}

export interface ConfigHistoryEntry {
  configName: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
  changedAt: string;
  changedBy?: string;
}

/** List all registered runtime config namespaces */
export async function fetchConfigs(): Promise<ConfigItem[]> {
  const res = await fetch("/api/configs", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data?.items ?? [];
}

/** Get a single runtime config namespace by name */
export async function fetchConfig(name: string): Promise<ConfigItem | null> {
  const res = await fetch(`/api/configs/${encodeURIComponent(name)}`, {
    headers: getAuthHeaders(),
  });
  handleUnauthorized(res);
  if (res.status === 404) return null;
  const json = await res.json();
  return json.data ?? null;
}

/** Update field values for a runtime config namespace */
export async function updateConfigValues(
  name: string,
  values: Record<string, unknown>,
): Promise<ConfigItem> {
  const res = await fetch(`/api/configs/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(values),
  });
  handleUnauthorized(res);
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Failed to update config");
  return json.data;
}

/** Get version history for a runtime config namespace */
export async function fetchConfigHistory(
  name: string,
  field?: string,
): Promise<ConfigHistoryEntry[]> {
  const url = field
    ? `/api/configs/${encodeURIComponent(name)}/history?field=${encodeURIComponent(field)}`
    : `/api/configs/${encodeURIComponent(name)}/history`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data?.items ?? [];
}

// ── ConfigStore KV API (spec 42 — dynamic config with scope cascade) ──

export type ConfigStoreScope = "global" | "tenant" | "department" | "user";

export interface ConfigStoreScopeRef {
  type: ConfigStoreScope;
  id?: string;
}

export interface ConfigStoreEntry {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  scope: ConfigStoreScope;
  scopeId?: string;
  encrypted: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface ConfigStoreVersion {
  id: string;
  configId: string;
  namespace: string;
  key: string;
  value: unknown;
  scope: ConfigStoreScope;
  scopeId?: string;
  version: number;
  changedBy?: string;
  changedAt: string;
  changeReason?: string;
}

/** List all entries in a ConfigStore namespace */
export async function fetchConfigStoreEntries(
  namespace: string,
  scope?: ConfigStoreScopeRef,
): Promise<ConfigStoreEntry[]> {
  const params = new URLSearchParams();
  if (scope?.type) params.set("scope", scope.type);
  if (scope?.id) params.set("scopeId", scope.id);
  const qs = params.toString();
  const url = `/api/config-store/${encodeURIComponent(namespace)}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data?.items ?? [];
}

/** Get a single ConfigStore value */
export async function fetchConfigStoreValue(
  namespace: string,
  key: string,
  scope?: ConfigStoreScopeRef,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (scope?.type) params.set("scope", scope.type);
  if (scope?.id) params.set("scopeId", scope.id);
  const qs = params.toString();
  const url = `/api/config-store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data?.value;
}

/** Set a ConfigStore value */
export async function setConfigStoreValue(
  namespace: string,
  key: string,
  value: unknown,
  options?: { scope?: ConfigStoreScopeRef; reason?: string },
): Promise<void> {
  const res = await fetch(
    `/api/config-store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        value,
        scope: options?.scope,
        reason: options?.reason,
      }),
    },
  );
  handleUnauthorized(res);
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Failed to set config value");
}

/** Delete a ConfigStore entry */
export async function deleteConfigStoreEntry(
  namespace: string,
  key: string,
  scope?: ConfigStoreScopeRef,
): Promise<void> {
  const params = new URLSearchParams();
  if (scope?.type) params.set("scope", scope.type);
  if (scope?.id) params.set("scopeId", scope.id);
  const qs = params.toString();
  const url = `/api/config-store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { method: "DELETE", headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Failed to delete config entry");
}

/** Get version history for a ConfigStore key */
export async function fetchConfigStoreHistory(
  namespace: string,
  key: string,
  scope?: ConfigStoreScopeRef,
): Promise<ConfigStoreVersion[]> {
  const params = new URLSearchParams();
  if (scope?.type) params.set("scope", scope.type);
  if (scope?.id) params.set("scopeId", scope.id);
  const qs = params.toString();
  const url = `/api/config-store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/history${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data?.items ?? [];
}

/** Rollback a ConfigStore key to a specific version */
export async function rollbackConfigStoreEntry(
  namespace: string,
  key: string,
  version: number,
  options?: { scope?: ConfigStoreScopeRef; reason?: string },
): Promise<void> {
  const res = await fetch(
    `/api/config-store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/rollback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        version,
        scope: options?.scope,
        reason: options?.reason,
      }),
    },
  );
  handleUnauthorized(res);
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Failed to rollback config");
}
