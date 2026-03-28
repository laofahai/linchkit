/**
 * Schema metadata REST endpoints.
 *
 * - GET /api/schemas — lightweight list of all schemas
 * - GET /api/schemas/:name — full schema with views, states, and links
 */

import type { Elysia } from "elysia";
import { generateDefaultViews } from "../default-views";
import type { ServerOptions } from "../server";

export function mountSchemaRoutes(app: Elysia, options: ServerOptions): void {
  const schemaRegistry = options.schemaRegistry;
  const views = options.views;
  const capabilities = options.capabilities ?? [];

  app
    .get("/api/schemas", () => {
      if (!schemaRegistry) {
        return { success: true, data: [] };
      }
      // Lightweight list — name/label/description/icon for navigation
      const schemas = schemaRegistry.getAll().map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
        icon: s.presentation?.icon,
        internal: schemaRegistry.isInternal(s.name) || undefined,
      }));
      return { success: true, data: schemas };
    })
    .get("/api/schemas/:name", ({ params, set }) => {
      if (!schemaRegistry) {
        set.status = 404;
        return { success: false, error: { message: "Schema registry not configured." } };
      }
      const schema = schemaRegistry.get(params.name);
      if (!schema) {
        set.status = 404;
        return { success: false, error: { message: `Schema "${params.name}" not found.` } };
      }
      // Bundle schema + views + state machines in one response
      const schemaViews = views?.get(params.name) ?? [];
      const viewsMap: Record<string, unknown> = {};
      for (const v of schemaViews) {
        viewsMap[v.name] = v;
      }
      // Generate default views when none are explicitly defined
      if (Object.keys(viewsMap).length === 0) {
        const defaults = generateDefaultViews(schema);
        for (const [k, v] of Object.entries(defaults)) {
          viewsMap[k] = v;
        }
      }
      // Collect all state machines that belong to this schema from all capabilities
      const schemaStates = capabilities.flatMap((cap) =>
        (cap.states ?? []).filter((s) => s.schema === params.name),
      );
      // Collect all links related to this schema (from or to)
      const schemaLinks = capabilities.flatMap((cap) =>
        (cap.links ?? []).filter((l) => l.from === params.name || l.to === params.name),
      );
      const internal = schemaRegistry.isInternal(params.name) || undefined;
      return {
        success: true,
        data: { ...schema, views: viewsMap, states: schemaStates, links: schemaLinks, internal },
      };
    });
}
