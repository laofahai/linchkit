/**
 * useRecordTemplates — Client-side record template management backed by localStorage.
 *
 * Key: `linchkit:record-templates:${schemaName}`
 * Value: array of RecordTemplate objects.
 *
 * Server-side persistence (DB table `_linchkit_record_templates`) can replace
 * this later without changing the public hook API.
 */

import type { CreateRecordTemplateInput, RecordTemplate } from "@linchkit/core/types";
import { useCallback, useMemo, useSyncExternalStore } from "react";

// ── localStorage helpers ─────────────────────────────────────────

function storageKey(schemaName: string): string {
  return `linchkit:record-templates:${schemaName}`;
}

function readTemplates(schemaName: string): RecordTemplate[] {
  try {
    const raw = localStorage.getItem(storageKey(schemaName));
    if (!raw) return [];
    return JSON.parse(raw) as RecordTemplate[];
  } catch {
    return [];
  }
}

function writeTemplates(schemaName: string, templates: RecordTemplate[]): void {
  localStorage.setItem(storageKey(schemaName), JSON.stringify(templates));
  window.dispatchEvent(
    new CustomEvent("linchkit:record-templates-change", { detail: schemaName }),
  );
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

export function useRecordTemplates(schemaName: string) {
  const getSnapshot = useCallback(() => {
    return localStorage.getItem(storageKey(schemaName)) ?? "[]";
  }, [schemaName]);

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
        schemaName: input.schemaName,
        name: input.name,
        description: input.description,
        icon: input.icon,
        values: input.values,
        isShared: input.isShared ?? true,
        sortOrder: input.sortOrder ?? 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const current = readTemplates(schemaName);
      writeTemplates(schemaName, [...current, template]);
      return template;
    },
    [schemaName],
  );

  const updateTemplate = useCallback(
    (templateId: string, updates: Partial<Omit<RecordTemplate, "id" | "schemaName" | "createdAt">>): void => {
      const current = readTemplates(schemaName);
      const updated = current.map((t) =>
        t.id === templateId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t,
      );
      writeTemplates(schemaName, updated);
    },
    [schemaName],
  );

  const deleteTemplate = useCallback(
    (templateId: string): void => {
      const current = readTemplates(schemaName);
      writeTemplates(
        schemaName,
        current.filter((t) => t.id !== templateId),
      );
    },
    [schemaName],
  );

  const getTemplate = useCallback(
    (templateId: string): RecordTemplate | undefined => {
      return readTemplates(schemaName).find((t) => t.id === templateId);
    },
    [schemaName],
  );

  return { templates, createTemplate, updateTemplate, deleteTemplate, getTemplate };
}
