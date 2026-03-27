/**
 * SSE subscription endpoint.
 *
 * - GET /api/subscribe — Server-Sent Events stream for real-time updates
 */

import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import {
  SubscriptionManager,
  formatSSEEvent,
  parseSubscriptionQuery,
} from "../subscription-manager";
import type { SubscriptionEvent } from "../subscription-manager";
import { resolveActor } from "./shared";

export function mountSubscriptionRoutes(
  app: Elysia,
  options: ServerOptions,
): void {
  const eventBus = options.eventBus;
  const subscriptionConfig = options.subscriptionConfig;
  const resolveRequestActor = options.resolveRequestActor;
  const resolveRequestTenantId = options.resolveRequestTenantId;
  const schemaRegistry = options.schemaRegistry;

  if (!eventBus) return;

  const subManager = new SubscriptionManager(eventBus, subscriptionConfig);

  // Wire permission checker: verify the actor can read the schema before delivering events.
  // Check schema exposure config — if GraphQL is explicitly disabled, deny SSE events too.
  if (schemaRegistry) {
    const permGroups = options.permissionGroups;
    subManager.setPermissionChecker((actor, schemaName) => {
      const schemaDef = schemaRegistry.get(schemaName);
      if (!schemaDef) return false; // Unknown schema — deny
      // If exposure is configured and graphql is explicitly false, deny
      if (schemaDef.exposure?.graphql === false) return false;
      // Basic RBAC: if permission groups are configured, check actor has read access
      if (permGroups && actor && actor.type !== "system") {
        const actorGroups = new Set(actor.groups ?? []);
        // Find if any permission group grants read access to this schema for the actor's groups.
        // Permission structure: permissions[capabilityName][schemaName].data.read
        const hasReadPermission = permGroups.some((pg) => {
          if (!actorGroups.has(pg.name)) return false;
          // Search across all capabilities for this schema
          for (const capPerms of Object.values(pg.permissions ?? {})) {
            const schemaPerms = capPerms[schemaName];
            if (schemaPerms?.data?.read && schemaPerms.data.read !== "none") return true;
          }
          return false;
        });
        // If permission groups exist but none grant read, deny (unless actor has no groups — allow for backward compat)
        if (actorGroups.size > 0 && !hasReadPermission) return false;
      }
      return true;
    });
  }

  subManager.start();

  app.get("/api/subscribe", async ({ request, set, query }) => {
    // Resolve actor for permission filtering
    const actor = await resolveActor(request, resolveRequestActor);
    const tenantId = resolveRequestTenantId
      ? await resolveRequestTenantId(request, actor)
      : undefined;

    // Parse filter from query params
    const filter = parseSubscriptionQuery(query as Record<string, string | undefined>);
    filter.tenantId = tenantId;

    // Set up SSE response via ReadableStream
    let connectionId: string | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const push = (event: SubscriptionEvent | null): boolean => {
          try {
            const eventId = subManager.nextEventId();
            const text = formatSSEEvent(event, event ? eventId : undefined);
            controller.enqueue(encoder.encode(text));
            return true;
          } catch {
            // Stream closed by client — signal that push failed
            return false;
          }
        };

        const close = () => {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        };

        connectionId = subManager.addConnection({
          userId: actor.id,
          actor,
          filter,
          push,
          close,
        });

        if (!connectionId) {
          // Too many connections for this user
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: "Too many connections" })}\n\n`,
            ),
          );
          controller.close();
          return;
        }

        // Send initial connection event
        controller.enqueue(
          encoder.encode(
            `event: connected\ndata: ${JSON.stringify({ connectionId })}\n\n`,
          ),
        );
      },
      cancel() {
        if (connectionId) {
          subManager.removeConnection(connectionId);
        }
      },
    });

    set.headers["content-type"] = "text/event-stream";
    set.headers["cache-control"] = "no-cache";
    set.headers["connection"] = "keep-alive";
    set.headers["x-accel-buffering"] = "no";

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // Store manager reference for cleanup on server close
  // biome-ignore lint/suspicious/noExplicitAny: attaching to Elysia instance for lifecycle management
  (app as any).__subscriptionManager = subManager;

  // Register shutdown handler to stop heartbeat/idle timers via Elysia lifecycle only.
  // Avoid process-level signal handlers — they leak when multiple server instances are created.
  app.onStop(() => subManager.stop());
}
