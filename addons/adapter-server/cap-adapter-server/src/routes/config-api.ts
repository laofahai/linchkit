/**
 * Runtime config REST endpoints.
 *
 * - GET  /api/configs              — list all registered config namespaces
 * - GET  /api/configs/:name        — get a config definition with current values
 * - PATCH /api/configs/:name       — update one or more field values
 * - GET  /api/configs/:name/history — get change history for a config namespace
 */

import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { notFound, serviceUnavailable } from "./shared";

export function mountConfigRoutes(app: Elysia, options: ServerOptions): void {
  const registry = options.runtimeConfigRegistry;

  app
    // List all registered config definitions with current values
    .get("/api/configs", ({ set }) => {
      if (!registry) {
        return serviceUnavailable(set, "Runtime config registry not configured.", 501);
      }
      const items = registry.list().map((def) => ({
        name: def.name,
        entity: def.entity,
        label: def.label,
        fields: def.fields,
        values: registry.getValues(def.name),
      }));
      return { success: true, data: { items, total: items.length } };
    })

    // Get a single config namespace with definition and current values
    .get("/api/configs/:name", ({ params, set }) => {
      if (!registry) {
        return serviceUnavailable(set, "Runtime config registry not configured.", 501);
      }
      const def = registry.get(params.name);
      if (!def) {
        return notFound(set, `Config "${params.name}" not found.`);
      }
      return {
        success: true,
        data: {
          name: def.name,
          entity: def.entity,
          label: def.label,
          fields: def.fields,
          values: registry.getValues(def.name),
        },
      };
    })

    // Update one or more field values for a config namespace
    .patch("/api/configs/:name", ({ params, body, set }) => {
      if (!registry) {
        return serviceUnavailable(set, "Runtime config registry not configured.", 501);
      }
      const def = registry.get(params.name);
      if (!def) {
        return notFound(set, `Config "${params.name}" not found.`);
      }

      const updates = (body ?? {}) as Record<string, unknown>;
      const errors: string[] = [];

      for (const [fieldName, value] of Object.entries(updates)) {
        try {
          registry.setValue(params.name, fieldName, value);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      if (errors.length > 0) {
        set.status = 400;
        return { success: false, error: { message: errors.join("; ") } };
      }

      return {
        success: true,
        data: {
          name: def.name,
          values: registry.getValues(def.name),
        },
      };
    })

    // Get version history for a config namespace
    .get("/api/configs/:name/history", ({ params, query, set }) => {
      if (!registry) {
        return serviceUnavailable(set, "Runtime config registry not configured.", 501);
      }
      const def = registry.get(params.name);
      if (!def) {
        return notFound(set, `Config "${params.name}" not found.`);
      }
      const fieldFilter = query.field as string | undefined;
      const entries = registry.getHistory(params.name, fieldFilter);
      return { success: true, data: { items: entries, total: entries.length } };
    });
}
