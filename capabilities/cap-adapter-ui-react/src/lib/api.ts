/**
 * API client for LinchKit server.
 *
 * Provides GraphQL query/mutation helpers and REST action execution.
 * Uses plain fetch — no external GraphQL client library needed.
 */

// ── Auth header helper ──────────────────────────────────

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("linchkit:token");
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

function handleUnauthorized(res: Response): void {
  if (res.status === 401) {
    localStorage.removeItem("linchkit:token");
    localStorage.removeItem("linchkit:authenticated");
    window.location.href = "/login";
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

// ── Schema metadata ─────────────────────────────────────

/** Lightweight schema info for navigation (from GET /api/schemas) */
export interface SchemaInfo {
  name: string;
  label?: string;
  description?: string;
}

/** Full schema bundle with views (from GET /api/schemas/:name) */
export interface SchemaBundle {
  name: string;
  label?: string;
  description?: string;
  fields: Record<string, unknown>;
  presentation?: Record<string, unknown>;
  views: Record<string, unknown>;
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
