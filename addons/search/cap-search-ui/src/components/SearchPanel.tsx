/**
 * SearchPanel — composes input + results with debounced search.
 *
 * Local state:
 *   - query   : current input text (controlled).
 *   - hits    : last successful result set.
 *   - loading : in-flight indicator.
 *   - error   : last error message (cleared on next query change).
 *
 * Behavior:
 *   - Queries shorter than `minQueryLength` (default 2) never hit the
 *     server; the panel shows an empty-state hint instead.
 *   - Debounce: 200ms after the last keystroke before the search is
 *     issued. A monotonic request seq guards against stale responses
 *     overwriting a newer in-flight result.
 *   - On empty hit array, the panel shows a "no results" state instead
 *     of an empty list.
 *
 * Search transport is injectable via the `search` prop so the panel
 * can be reused with a mock or a non-GraphQL backend (e.g. an embedded
 * preview). When the prop is omitted, the parent must wire one via the
 * default `useSearchClient()` hook (see SearchPage).
 */

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchHit } from "../hooks/useSearchClient";
import GlobalSearchInput from "./GlobalSearchInput";
import SearchResultsList from "./SearchResultsList";

export interface SearchPanelProps {
  /** Async search callable — typically `useSearchClient().search`. */
  search: (query: string, options?: { limit?: number }) => Promise<SearchHit[]>;
  /** Debounce wait in milliseconds (default 200). */
  debounceMs?: number;
  /** Minimum query length before the first network call (default 2). */
  minQueryLength?: number;
  /** Soft cap on rendered + requested results (default 20). */
  limit?: number;
  /** Called when the user activates a hit row. */
  onSelect?: (hit: SearchHit) => void;
  /** Optional extra class on the outermost wrapper. */
  className?: string;
}

export function SearchPanel(props: SearchPanelProps) {
  const { search, debounceMs = 200, minQueryLength = 2, limit = 20, onSelect, className } = props;

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic id — drop responses whose seq is no longer current.
  // Avoids the classic stale-response overwrite race where a slow earlier
  // request resolves after a faster later one (typing fast triggers this).
  const requestSeqRef = useRef(0);

  const trimmed = query.trim();
  const tooShort = trimmed.length < minQueryLength;

  const runSearch = useCallback(
    async (text: string, seq: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await search(text, { limit });
        if (seq !== requestSeqRef.current) return;
        setHits(result);
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setHits([]);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [search, limit],
  );

  useEffect(() => {
    if (tooShort) {
      // Cancel any in-flight request so stale results can't paint.
      requestSeqRef.current++;
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }

    const seq = ++requestSeqRef.current;
    const handle = setTimeout(() => {
      runSearch(trimmed, seq);
    }, debounceMs);

    return () => clearTimeout(handle);
  }, [trimmed, tooShort, debounceMs, runSearch]);

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <GlobalSearchInput value={query} onSearch={setQuery} />
        {loading && (
          <Loader2
            aria-label="Loading search results"
            className="size-4 animate-spin text-muted-foreground"
          />
        )}
      </div>

      <div className="mt-3" aria-live="polite">
        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {!error && tooShort && (
          <p className="text-xs text-muted-foreground">
            Type at least {minQueryLength} characters to search.
          </p>
        )}

        {!error && !tooShort && !loading && hits.length === 0 && (
          <p className="text-xs text-muted-foreground">No results for "{trimmed}".</p>
        )}

        {!error && hits.length > 0 && (
          <SearchResultsList hits={hits} limit={limit} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

export default SearchPanel;
