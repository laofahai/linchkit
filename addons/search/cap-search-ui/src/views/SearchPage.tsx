/**
 * SearchPage — top-level admin route hosting the global search panel.
 *
 * Composes:
 *   - Header: page title + subtitle.
 *   - Body  : <SearchPanel> wired to the default `useSearchClient()`.
 *   - Footer: keyboard hint (⌘K to focus, Esc to clear).
 *
 * The page itself is intentionally tiny so the panel can be embedded
 * in any shell (a topbar dropdown, a command palette, a sidebar) by
 * importing <SearchPanel> directly with a custom `search` prop.
 */

import { useTranslation } from "react-i18next";
import SearchPanel from "../components/SearchPanel";
import { useSearchClient } from "../hooks/useSearchClient";

export function SearchPage() {
  const client = useSearchClient();
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold">{t("search.page.title", "Global Search")}</h1>
        <p className="text-xs text-muted-foreground">
          {t(
            "search.page.subtitle",
            "Full-text search across every entity with a registered defineSearchIndex.",
          )}
        </p>
      </header>

      <main className="flex-1">
        <SearchPanel search={client.search} />
      </main>

      <footer className="text-[10px] text-muted-foreground">
        {t("search.page.tipPrefix", "Tip: press")}{" "}
        <kbd className="rounded border bg-muted px-1 font-mono">⌘K</kbd> /{" "}
        <kbd className="rounded border bg-muted px-1 font-mono">Ctrl+K</kbd>{" "}
        {t("search.page.tipFocusInput", "to focus the input,")}{" "}
        <kbd className="rounded border bg-muted px-1 font-mono">Esc</kbd>{" "}
        {t("search.page.tipClear", "to clear.")}
      </footer>
    </div>
  );
}

export default SearchPage;
