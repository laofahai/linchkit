/**
 * SearchResultsList — flat list of search hits.
 *
 * Each row shows the entity name (badge), the record id (snippet body),
 * and the right-aligned ts_rank score formatted to 3 decimals.
 *
 * Rendering choice — plain text, never HTML:
 * The cap-search service does NOT return a pre-escaped ts_headline
 * snippet; it returns only `{ entity, recordId, score }`. There is no
 * markup to embed, so we render every value as plain text via React's
 * default escaping. If a future cap-search phase ships ts_headline
 * snippets, the safe upgrade path is to thread the HTML through a
 * dedicated `snippetHtml` field with a sanitizer rather than reusing
 * `recordId`.
 *
 * Virtualization: kept off in Phase 1 — the limit cap on the wire
 * is 200 (DrizzleSearchService clamps the value), small enough to
 * render without windowing. The parent simply slices to `limit`.
 */

import { Badge } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { Hash } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SearchHit } from "../hooks/useSearchClient";

export interface SearchResultsListProps {
  hits: readonly SearchHit[];
  /** Soft cap on rendered rows (defaults to the server cap of 200). */
  limit?: number;
  /** Called when the user activates a row (click or keyboard Enter). */
  onSelect?: (hit: SearchHit) => void;
  className?: string;
}

function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "0.000";
  return score.toFixed(3);
}

export function SearchResultsList(props: SearchResultsListProps) {
  const { hits, limit = 200, onSelect, className } = props;
  const { t } = useTranslation();
  const visible = hits.slice(0, Math.max(0, limit));
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  if (visible.length === 0) return null;

  function focusRow(index: number) {
    if (visible.length === 0) return;
    const wrapped = (index + visible.length) % visible.length;
    rowRefs.current[wrapped]?.focus();
  }

  // <div role="listbox"> rather than <ul> — biome's
  // noNoninteractiveElementToInteractiveRole rule rejects the
  // <ul role="listbox"> / <li role="option"> combination even though
  // WAI-ARIA explicitly endorses that pattern. The semantic role is
  // what matters for AT; the underlying tag is just a container.
  return (
    <div
      className={cn("flex flex-col divide-y rounded-md border bg-card", className)}
      role="listbox"
      aria-label={t("search.results.ariaLabel", "Search results")}
    >
      {visible.map((hit, index) => {
        const key = `${hit.entity}:${hit.recordId}`;
        const interactive = typeof onSelect === "function";
        return (
          <div
            key={key}
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            role="option"
            aria-selected={false}
            tabIndex={interactive ? 0 : -1}
            className={cn(
              "flex items-center justify-between gap-3 px-3 py-2 text-sm",
              interactive && "cursor-pointer hover:bg-muted/60 focus:bg-muted focus:outline-none",
            )}
            onClick={interactive ? () => onSelect?.(hit) : undefined}
            onKeyDown={
              interactive
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect?.(hit);
                      return;
                    }
                    // Arrow / Home / End navigation per WAI-ARIA listbox.
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      focusRow(index + 1);
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      focusRow(index - 1);
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      focusRow(0);
                    } else if (event.key === "End") {
                      event.preventDefault();
                      focusRow(visible.length - 1);
                    }
                  }
                : undefined
            }
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                {hit.entity}
              </Badge>
              <span className="truncate text-xs text-muted-foreground" title={hit.recordId}>
                <Hash aria-hidden="true" className="mr-1 inline size-3" />
                {hit.recordId}
              </span>
            </div>
            <span className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
              {formatScore(hit.score)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default SearchResultsList;
