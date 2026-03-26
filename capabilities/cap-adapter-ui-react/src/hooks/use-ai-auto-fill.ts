/**
 * useAiAutoFill — Hook for AI-powered form auto-fill.
 *
 * Sends current form context to the AI auto-fill endpoint and manages
 * suggestion state (pending, accepted, rejected per field).
 */

import type { SchemaDefinition } from "@linchkit/core/types";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiFieldSuggestion } from "../lib/api";
import { requestAiAutoFill } from "../lib/api";

export interface AiSuggestionState {
  /** Suggestions keyed by field name */
  suggestions: Record<string, AiFieldSuggestion>;
  /** Whether a request is in progress */
  loading: boolean;
  /** Error message if the request failed */
  error: string | null;
}

export interface UseAiAutoFillReturn {
  /** Current suggestion state */
  state: AiSuggestionState;
  /** Request AI suggestions for empty fields */
  requestSuggestions: (currentValues: Record<string, unknown>) => Promise<void>;
  /** Accept a single field suggestion */
  acceptSuggestion: (fieldName: string) => void;
  /** Reject (dismiss) a single field suggestion */
  rejectSuggestion: (fieldName: string) => void;
  /** Accept all remaining suggestions */
  acceptAll: () => void;
  /** Clear all suggestions */
  clearSuggestions: () => void;
  /** Check if a field has a pending suggestion */
  hasSuggestion: (fieldName: string) => boolean;
}

/** System fields that should never be suggested by AI */
const EXCLUDED_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "is_deleted",
]);

/** Field types that AI should not attempt to fill */
const EXCLUDED_FIELD_TYPES = new Set(["state", "has_many", "many_to_many"]);

/**
 * Build the fields descriptor for the AI auto-fill endpoint from a SchemaDefinition.
 */
function buildFieldDescriptors(
  schema: SchemaDefinition,
): Record<string, { label?: string; type?: string; required?: boolean; options?: string[]; description?: string }> {
  const result: Record<string, { label?: string; type?: string; required?: boolean; options?: string[]; description?: string }> = {};

  for (const [name, field] of Object.entries(schema.fields)) {
    if (EXCLUDED_FIELDS.has(name)) continue;
    if (field.type && EXCLUDED_FIELD_TYPES.has(field.type)) continue;
    if (field.derived) continue;

    const descriptor: { label?: string; type?: string; required?: boolean; options?: string[]; description?: string } = {
      label: field.label,
      type: field.type,
      required: field.required,
    };

    // Include enum options if available
    if (field.type === "enum" && "options" in field && Array.isArray(field.options)) {
      descriptor.options = field.options.map((o: string | { value: string }) =>
        typeof o === "string" ? o : o.value,
      );
    }

    if (field.description) {
      descriptor.description = field.description;
    }

    result[name] = descriptor;
  }

  return result;
}

export function useAiAutoFill(
  schema: SchemaDefinition,
  onAccept: (fieldName: string, value: unknown) => void,
): UseAiAutoFillReturn {
  const { i18n } = useTranslation();
  const [state, setState] = useState<AiSuggestionState>({
    suggestions: {},
    loading: false,
    error: null,
  });

  const requestSuggestions = useCallback(
    async (currentValues: Record<string, unknown>) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      try {
        const fields = buildFieldDescriptors(schema);
        const result = await requestAiAutoFill({
          schema: schema.name,
          fields,
          currentValues,
          locale: i18n.language,
        });

        setState({
          suggestions: result.suggestions,
          loading: false,
          error: null,
        });
      } catch (err) {
        setState({
          suggestions: {},
          loading: false,
          error: err instanceof Error ? err.message : "AI auto-fill failed",
        });
      }
    },
    [schema, i18n.language],
  );

  const acceptSuggestion = useCallback(
    (fieldName: string) => {
      setState((prev) => {
        const suggestion = prev.suggestions[fieldName];
        if (!suggestion) return prev;

        // Notify caller (value application is typically handled by the form component)
        onAccept(fieldName, suggestion.value);

        // Remove from suggestions
        const next = { ...prev.suggestions };
        delete next[fieldName];
        return { ...prev, suggestions: next };
      });
    },
    [onAccept],
  );

  const rejectSuggestion = useCallback((fieldName: string) => {
    setState((prev) => {
      const next = { ...prev.suggestions };
      delete next[fieldName];
      return { ...prev, suggestions: next };
    });
  }, []);

  const acceptAll = useCallback(() => {
    setState((prev) => {
      for (const [fieldName, suggestion] of Object.entries(prev.suggestions)) {
        onAccept(fieldName, suggestion.value);
      }
      return { ...prev, suggestions: {} };
    });
  }, [onAccept]);

  const clearSuggestions = useCallback(() => {
    setState((prev) => ({ ...prev, suggestions: {} }));
  }, []);

  const hasSuggestion = useCallback(
    (fieldName: string) => fieldName in state.suggestions,
    [state.suggestions],
  );

  return {
    state,
    requestSuggestions,
    acceptSuggestion,
    rejectSuggestion,
    acceptAll,
    clearSuggestions,
    hasSuggestion,
  };
}
