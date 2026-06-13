import { getAuthHeaders, handleUnauthorized } from "./api";

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  meta?: { executionId?: string };
}

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
