/**
 * useRecordTemplates — Client-side record template management backed by localStorage.
 *
 * Key: `linchkit:record-templates:${entityName}`
 * Value: array of RecordTemplate objects.
 *
 * Server-side persistence (DB table `_linchkit_record_templates`) can replace
 * this later without changing the public hook API.
 */

import type { CreateRecordTemplateInput, RecordTemplate } from "@linchkit/core/types";
import { useCallback, useMemo, useSyncExternalStore } from "react";

// ── localStorage helpers ─────────────────────────────────────────

function storageKey(entityName: string): string {
  return `linchkit:record-templates:${entityName}`;
}

function readTemplates(entityName: string): RecordTemplate[] {
  try {
    const raw = localStorage.getItem(storageKey(entityName));
    if (!raw) return [];
    return JSON.parse(raw) as RecordTemplate[];
  } catch {
    return [];
  }
}

function writeTemplates(entityName: string, templates: RecordTemplate[]): void {
  localStorage.setItem(storageKey(entityName), JSON.stringify(templates));
  window.dispatchEvent(new CustomEvent("linchkit:record-templates-change", { detail: entityName }));
}

function generateId(): string {
  return `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── External store for useSyncExternalStore ──────────────────────

function subscribeToTemplates(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener("linchkit:record-templates-change", handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("linchkit:record-templates-change", handler);
    window.removeEventListener("storage", handler);
  };
}

// ── Public hook ──────────────────────────────────────────────────

export function useRecordTemplates(entityName: string) {
  const getSnapshot = useCallback(() => {
    return localStorage.getItem(storageKey(entityName)) ?? "[]";
  }, [entityName]);

  const raw = useSyncExternalStore(subscribeToTemplates, getSnapshot, () => "[]");
  const templates = useMemo<RecordTemplate[]>(() => {
    try {
      return (JSON.parse(raw) as RecordTemplate[]).sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
      );
    } catch {
      return [];
    }
  }, [raw]);

  const createTemplate = useCallback(
    (input: CreateRecordTemplateInput): RecordTemplate => {
      const template: RecordTemplate = {
        id: generateId(),
        entityName: input.entityName,
        name: input.name,
        description: input.description,
        icon: input.icon,
        values: input.values,
        isShared: input.isShared ?? true,
        sortOrder: input.sortOrder ?? 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const current = readTemplates(entityName);
      writeTemplates(entityName, [...current, template]);
      return template;
    },
    [entityName],
  );

  const updateTemplate = useCallback(
    (
      templateId: string,
      updates: Partial<Omit<RecordTemplate, "id" | "entityName" | "createdAt">>,
    ): void => {
      const current = readTemplates(entityName);
      const updated = current.map((t) =>
        t.id === templateId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t,
      );
      writeTemplates(entityName, updated);
    },
    [entityName],
  );

  const deleteTemplate = useCallback(
    (templateId: string): void => {
      const current = readTemplates(entityName);
      writeTemplates(
        entityName,
        current.filter((t) => t.id !== templateId),
      );
    },
    [entityName],
  );

  const getTemplate = useCallback(
    (templateId: string): RecordTemplate | undefined => {
      return readTemplates(entityName).find((t) => t.id === templateId);
    },
    [entityName],
  );

  return { templates, createTemplate, updateTemplate, deleteTemplate, getTemplate };
}
