const BASE_URL = "http://localhost:3001";

export async function graphql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors[0]?.message}`);
  }
  return json.data as T;
}

export async function executeAction(
  name: string,
  input: Record<string, unknown> = {},
): Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  meta?: { executionId: string };
}> {
  const res = await fetch(`${BASE_URL}/api/actions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return res.json() as Promise<ReturnType<typeof executeAction>>;
}

export async function fetchSchemas(): Promise<{ name: string; label: string }[]> {
  const res = await fetch(`${BASE_URL}/api/schemas`);
  const json = (await res.json()) as {
    success: boolean;
    data: { name: string; label: string }[];
  };
  return json.data;
}
