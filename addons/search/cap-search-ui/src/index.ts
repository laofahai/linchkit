/**
 * Entry point for cap-search-ui.
 *
 * Registers the global search admin route. Imported by the host UI
 * bundle (cap-adapter-ui) to wire the capability into the admin layout.
 */

import { registerAdminRoute } from "@linchkit/cap-adapter-ui/route-registry";

export { capSearchUi } from "./capability";
export { default as GlobalSearchInput } from "./components/GlobalSearchInput";
export { default as SearchPanel } from "./components/SearchPanel";
export { default as SearchResultsList } from "./components/SearchResultsList";
export type { SearchClient, SearchHit, UseSearchClientOptions } from "./hooks/useSearchClient";
export { useSearchClient } from "./hooks/useSearchClient";
export { default as SearchPage } from "./views/SearchPage";

registerAdminRoute({
  id: "search",
  capability: "cap-search-ui",
  path: "/admin/search",
  label: "search.page.title",
  icon: "Search",
  // Sit just after the audit viewer (order 110) so search lands at the
  // top of the system tools section without clashing with built-in entries.
  order: 120,
  component: () => import("./views/SearchPage"),
});
