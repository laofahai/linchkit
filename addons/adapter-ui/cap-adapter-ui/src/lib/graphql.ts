import { getAuthHeaders, handleUnauthorized } from "./api";

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: { message: string; locations?: unknown[]; path?: string[] }[];
}

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

export function throwOnErrors(res: GraphQLResponse): void {
  const errors = res.errors;
  if (errors && errors.length > 0) {
    const firstError = errors.at(0);
    throw new Error(firstError?.message ?? "Unknown GraphQL error");
  }
}
