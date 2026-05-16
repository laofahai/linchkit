/**
 * Capability definition for cap-search-ui.
 *
 * Provides a Global Search widget — a controlled text input + a
 * results list backed by cap-search's `search` GraphQL query. Used
 * by the admin UI as a top-bar omnibox and by the standalone
 * `/admin/search` page mounted by this capability.
 *
 * Backend data source: the `search(q: String!, entity: String, limit: Int)`
 * query exposed by `cap-search` via cap-adapter-server's GraphQL extension
 * point. This capability is read-only and never issues mutations.
 *
 * Issue: #141
 * Spec: 14 (System Capabilities), 24 (Search)
 */

import { defineCapability } from "@linchkit/core";

export const capSearchUi = defineCapability({
  name: "cap-search-ui",
  label: "Global Search UI",
  description:
    "Admin UI widget for the global full-text search — controlled input with " +
    "debounced GraphQL queries and a results list grouped by entity.",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "search",
  dependencies: ["cap-search", "cap-adapter-ui"],
  autoInstall: true,
});
