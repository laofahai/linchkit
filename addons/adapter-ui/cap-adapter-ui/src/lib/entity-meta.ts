import type { RelationDefinition, SemanticRelation, StateDefinition } from "@linchkit/core/types";
import { getAuthHeaders, handleUnauthorized } from "./api";

export interface EntityInfo {
  name: string;
  label?: string;
  description?: string;
  icon?: string;
  internal?: boolean;
}

/** @deprecated Use EntityInfo instead */
export type SchemaInfo = EntityInfo;

export interface EntityBundle {
  name: string;
  label?: string;
  description?: string;
  fields: Record<string, unknown>;
  presentation?: Record<string, unknown>;
  views: Record<string, unknown>;
  states?: StateDefinition[];
  relations?: RelationDefinition[];
  internal?: boolean;
}

/** @deprecated Use EntityBundle instead */
export type SchemaBundle = EntityBundle;

export interface EntityOnchangeResult {
  updates: Record<string, unknown>;
  warnings?: string[];
}

export async function fetchEntities(): Promise<EntityInfo[]> {
  const res = await fetch("/api/entities", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data ?? [];
}

/** @deprecated Use fetchEntities instead */
export const fetchSchemas = fetchEntities;

export async function fetchEntityBundle(name: string): Promise<EntityBundle | null> {
  const res = await fetch(`/api/entities/${encodeURIComponent(name)}`, {
    headers: getAuthHeaders(),
  });
  handleUnauthorized(res);
  if (!res.ok) return null;
  const json = await res.json();
  return json.data ?? null;
}

/** @deprecated Use fetchEntityBundle instead */
export const fetchSchemaBundle = fetchEntityBundle;

export async function fetchRelations(): Promise<RelationDefinition[]> {
  const res = await fetch("/api/relations", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data ?? [];
}

export async function fetchSemanticRelations(): Promise<SemanticRelation[]> {
  const res = await fetch("/api/semantic-relations", { headers: getAuthHeaders() });
  handleUnauthorized(res);
  const json = await res.json();
  return json.data ?? [];
}

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
