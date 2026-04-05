/**
 * ConfigStore REST endpoints — dynamic KV config with scope cascade (spec 42).
 *
 * - GET    /api/config-store/:namespace              — list entries in a namespace
 * - GET    /api/config-store/:namespace/:key          — get a single entry (with scope cascade)
 * - PUT    /api/config-store/:namespace/:key          — set a config value
 * - DELETE /api/config-store/:namespace/:key          — delete a config entry
 * - GET    /api/config-store/:namespace/:key/history  — version history
 * - POST   /api/config-store/:namespace/:key/rollback — rollback to a version
 */

import type { ConfigScope, ConfigScopeRef } from "@linchkit/core";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { badRequest, serviceUnavailable } from "./shared";

const VALID_SCOPES: ConfigScope[] = ["global", "tenant", "department", "user"];

/** Parse scope query params into a ConfigScopeRef, or undefined. */
function parseScopeRef(query: Record<string, unknown>): ConfigScopeRef | undefined {
  const scopeType = query.scope as string | undefined;
  if (!scopeType) return undefined;
  if (!VALID_SCOPES.includes(scopeType as ConfigScope)) return undefined;
  return {
    type: scopeType as ConfigScope,
    id: (query.scopeId as string) || undefined,
  };
}

export function mountConfigStoreRoutes(app: Elysia, options: ServerOptions): void {
  const store = options.configStore;

  app
    // List all entries in a namespace
    .get("/api/config-store/:namespace", async ({ params, query, set }) => {
      if (!store) {
        return serviceUnavailable(set, "ConfigStore not configured.", 501);
      }
      try {
        const scope = parseScopeRef(query as Record<string, unknown>);
        const entries = await store.list(params.namespace, scope);
        return {
          success: true,
          data: { items: entries, total: entries.length },
        };
      } catch (err) {
        set.status = 500;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    })

    // Get a single config entry with scope cascade
    .get("/api/config-store/:namespace/:key", async ({ params, query, set }) => {
      if (!store) {
        return serviceUnavailable(set, "ConfigStore not configured.", 501);
      }
      try {
        const scope = parseScopeRef(query as Record<string, unknown>);
        const value = await store.get(params.namespace, params.key, scope);
        return { success: true, data: { namespace: params.namespace, key: params.key, value } };
      } catch (err) {
        set.status = 500;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    })

    // Set a config value
    .put("/api/config-store/:namespace/:key", async ({ params, body, set }) => {
      if (!store) {
        return serviceUnavailable(set, "ConfigStore not configured.", 501);
      }
      const payload = body as Record<string, unknown> | null;
      if (!payload || !("value" in payload)) {
        return badRequest(set, 'Request body must include a "value" field.');
      }
      try {
        const scopeRef = payload.scope
          ? {
              type: (payload.scope as Record<string, unknown>).type as ConfigScope,
              id: ((payload.scope as Record<string, unknown>).id as string) || undefined,
            }
          : undefined;
        await store.set(params.namespace, params.key, payload.value, {
          scope: scopeRef,
          changedBy: (payload.changedBy as string) || undefined,
          changeReason: (payload.reason as string) || undefined,
          encrypted: (payload.encrypted as boolean) || undefined,
        });
        return { success: true, data: { namespace: params.namespace, key: params.key } };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    })

    // Delete a config entry
    .delete("/api/config-store/:namespace/:key", async ({ params, query, set }) => {
      if (!store) {
        return serviceUnavailable(set, "ConfigStore not configured.", 501);
      }
      try {
        const scope = parseScopeRef(query as Record<string, unknown>);
        await store.delete(params.namespace, params.key, scope);
        return { success: true, data: null };
      } catch (err) {
        set.status = 500;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    })

    // Version history
    .get("/api/config-store/:namespace/:key/history", async ({ params, query, set }) => {
      if (!store) {
        return serviceUnavailable(set, "ConfigStore not configured.", 501);
      }
      try {
        const scope = parseScopeRef(query as Record<string, unknown>);
        const versions = await store.history(params.namespace, params.key, scope);
        return { success: true, data: { items: versions, total: versions.length } };
      } catch (err) {
        set.status = 500;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    })

    // Rollback to a specific version
    .post("/api/config-store/:namespace/:key/rollback", async ({ params, body, set }) => {
      if (!store) {
        return serviceUnavailable(set, "ConfigStore not configured.", 501);
      }
      const payload = body as Record<string, unknown> | null;
      if (!payload || typeof payload.version !== "number") {
        return badRequest(set, 'Request body must include a numeric "version" field.');
      }
      try {
        const scopeRef = payload.scope
          ? {
              type: (payload.scope as Record<string, unknown>).type as ConfigScope,
              id: ((payload.scope as Record<string, unknown>).id as string) || undefined,
            }
          : undefined;
        await store.rollback(params.namespace, params.key, payload.version, {
          scope: scopeRef,
          changedBy: (payload.changedBy as string) || undefined,
          changeReason: (payload.reason as string) || undefined,
        });
        return { success: true, data: { namespace: params.namespace, key: params.key } };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    });
}
