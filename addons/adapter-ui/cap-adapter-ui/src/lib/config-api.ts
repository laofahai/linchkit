import { getAuthHeaders, handleUnauthorized } from "./api";

// ── Runtime Config API ───────────────────────────────────

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

export async function fetchConfigs(): Promise<ConfigItem[]> {
  const res = await fetch("/api/configs", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data?.items ?? [];
}

export async function fetchConfig(name: string): Promise<ConfigItem | null> {
  const res = await fetch(`/api/configs/${encodeURIComponent(name)}`, {
    headers: getAuthHeaders(),
  });
  handleUnauthorized(res);
  if (res.status === 404) return null;
  const json = await res.json();
  return json.data ?? null;
}

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

// ── ConfigStore KV API (Spec 42 — dynamic config with scope cascade) ────────

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
