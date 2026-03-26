/**
 * useAISearch — Hook for AI-powered natural language search.
 *
 * Detects whether a search query is natural language (vs simple keyword),
 * sends it to the AI search endpoint, and returns DeclarativeCondition filters.
 */

import type { SchemaDefinition } from "@linchkit/core/types";
import { useCallback, useRef, useState } from "react";
import { type AISearchResult, aiSearch } from "../lib/api";

/** AI search state exposed to consumers */
export interface AISearchState {
  /** Whether an AI search is currently in progress */
  loading: boolean;
  /** The active AI filter result (null when no AI filter is applied) */
  result: AISearchResult | null;
  /** Error message if the AI search failed */
  error: string | null;
  /** The original query that produced the current AI filter */
  query: string | null;
}

/** Return type of the useAISearch hook */
export interface UseAISearchReturn {
  aiSearch: AISearchState;
  /** Trigger AI search for a query */
  triggerAISearch: (query: string) => Promise<void>;
  /** Clear the AI filter */
  clearAISearch: () => void;
  /** Check if a query looks like a natural language search */
  isNaturalLanguageQuery: (query: string) => boolean;
}

/**
 * Heuristic: detect whether a query is natural language vs simple keyword.
 *
 * Returns true if the query contains:
 * - Chinese comparison/filter words
 * - Comparison operators (>, <, =, >=, <=)
 * - Common filter phrases in English
 * - Multiple Chinese characters suggesting a sentence
 */
export function isNaturalLanguageQuery(query: string): boolean {
  if (!query || query.trim().length < 3) return false;

  const q = query.trim();

  // Chinese comparison / filter keywords
  const zhPatterns =
    /大于|小于|等于|不等于|包含|不包含|之前|之后|超过|低于|高于|至少|最多|状态|为|是|不是|介于|范围|排除|筛选|过滤|查找|搜索|所有|全部的|待|已/;
  if (zhPatterns.test(q)) return true;

  // Comparison operators embedded in text
  if (/[><=!]{1,2}\s*\d/.test(q)) return true;

  // English natural language filter phrases
  const enPatterns =
    /\b(greater than|less than|equal to|not equal|contains|before|after|between|where|status is|more than|at least|at most|excluding|including)\b/i;
  if (enPatterns.test(q)) return true;

  // If the query has significant Chinese content (sentence-like), treat as NL
  const chineseChars = q.match(/[\u4e00-\u9fff]/g);
  if (chineseChars && chineseChars.length >= 4) return true;

  return false;
}

/**
 * Build field metadata from SchemaDefinition for the AI search API.
 */
function buildFieldMeta(
  schema: SchemaDefinition,
): Record<string, { label?: string; type?: string; options?: string[] }> {
  const result: Record<string, { label?: string; type?: string; options?: string[] }> = {};
  for (const [name, field] of Object.entries(schema.fields)) {
    const meta: { label?: string; type?: string; options?: string[] } = {};
    if (typeof field === "object" && field !== null) {
      const f = field as Record<string, unknown>;
      if (typeof f.label === "string") meta.label = f.label;
      if (typeof f.type === "string") meta.type = f.type;
      if (Array.isArray(f.options)) {
        meta.options = f.options.map((o: unknown) => {
          if (typeof o === "string") return o;
          if (typeof o === "object" && o !== null && "value" in o) return String((o as { value: unknown }).value);
          return String(o);
        });
      }
      if (typeof f.enum === "object" && f.enum !== null) {
        meta.options = Object.keys(f.enum as Record<string, unknown>);
      }
    }
    result[name] = meta;
  }
  return result;
}

export function useAISearch(schema: SchemaDefinition | undefined): UseAISearchReturn {
  const [state, setState] = useState<AISearchState>({
    loading: false,
    result: null,
    error: null,
    query: null,
  });

  // Abort controller for cancelling in-flight requests
  const abortRef = useRef<AbortController | null>(null);

  const triggerAISearch = useCallback(
    async (query: string) => {
      if (!schema) return;

      // Cancel any pending request
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setState((prev) => ({ ...prev, loading: true, error: null }));

      try {
        const fields = buildFieldMeta(schema);
        const result = await aiSearch({
          query,
          schema: schema.name,
          fields,
        });

        // Check if aborted while waiting
        if (ctrl.signal.aborted) return;

        if (result) {
          setState({ loading: false, result, error: null, query });
        } else {
          setState({ loading: false, result: null, error: null, query: null });
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setState({
          loading: false,
          result: null,
          error: err instanceof Error ? err.message : "AI search failed",
          query: null,
        });
      }
    },
    [schema],
  );

  const clearAISearch = useCallback(() => {
    abortRef.current?.abort();
    setState({ loading: false, result: null, error: null, query: null });
  }, []);

  return {
    aiSearch: state,
    triggerAISearch,
    clearAISearch,
    isNaturalLanguageQuery,
  };
}
