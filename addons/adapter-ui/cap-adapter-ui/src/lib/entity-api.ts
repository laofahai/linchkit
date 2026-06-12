import { getAuthHeaders } from "./api";
import { graphql, throwOnErrors } from "./graphql";

export interface ListQueryOptions {
  schema: string;
  filter?: Record<string, unknown>;
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

export interface AvailableTransition {
  from: string;
  to: string;
  action: string;
  allowed: boolean;
  reason?: string | null;
}

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

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/**
 * Convert a snake_case/kebab-case entity name to PascalCase for GraphQL names.
 *
 * CONSUMER side of the GraphQL naming contract: the server generates type,
 * mutation, and subscription field names (e.g. `on{Pascal}Created`) with its
 * own identical helper — addons/adapter-server/cap-adapter-server/src/graphql/naming.ts.
 * The UI must not import server code (module boundary), so this copy must
 * stay behaviorally identical: "purchase_request" → "PurchaseRequest".
 * Pinned by __tests__/subscription-naming.test.ts here and
 * __tests__/graphql-naming.test.ts on the server.
 */
export function toPascalCase(name: string): string {
  const raw = name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const sanitized = raw.replace(/[^_0-9A-Za-z]/g, "");
  return GRAPHQL_NAME_RE.test(sanitized) ? sanitized : `_${sanitized}`;
}

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
