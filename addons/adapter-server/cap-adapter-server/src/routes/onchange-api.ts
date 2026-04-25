/**
 * Entity onchange REST endpoint (Spec 64).
 *
 * POST /api/entities/:entityName/onchange
 *
 * Interactive pre-save form computation. Given a triggering field change and
 * the current form values, return a suggested set of updates the UI can apply
 * to the unsaved form state. Onchange NEVER writes to the database and is
 * wholly separate from the Action Engine write path.
 *
 * Pipeline: passes through CommandLayer with `skipActionSlots = true` so that
 * auth / permission / tenant still run but exposure / pre-action / post-action
 * slots are skipped. The synthetic command name is `"<entityName>.onchange"`
 * (exists only for metrics/tracing labels) and `meta.onchange = { entity,
 * changedField }` carries the permission target so middlewares can perform an
 * entity-level READ check rather than looking up an action named `onchange`.
 * See Spec 64 §4.3.
 */

import type { OnchangeEvaluator } from "@linchkit/core/server";
import { consoleLogger, OnchangeEvaluatorError } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import {
  badRequest,
  notFound,
  resolveActor,
  resolveStatusCode,
  serverError,
  serviceUnavailable,
} from "./shared";

/**
 * Canonical authorization-denied envelope (Non-blocker 4). All 401/403 paths
 * through this endpoint return THE SAME payload so the response text cannot be
 * used as a side channel to distinguish "entity exists but you can't access it"
 * from "entity doesn't exist" or "auth token missing vs invalid". The specific
 * middleware-supplied detail is logged via `Logger.warn` for operator debugging.
 */
const AUTHZ_DENIED_BODY = {
  success: false as const,
  error: {
    code: "AUTHZ_DENIED",
    message: "Access denied",
  },
} as const;

/**
 * Build the synthetic command name for a given entity. Permission middleware
 * SHOULD NOT match on this name — the authoritative target is
 * `ctx.meta.onchange.entity`. The name is stable enough for metrics labels.
 */
export function buildOnchangeCommandName(entityName: string): string {
  return `${entityName}.onchange`;
}

export function mountOnchangeRoutes(
  app: Elysia,
  options: ServerOptions,
  onchangeEvaluator: OnchangeEvaluator | undefined,
): void {
  const { entityRegistry, commandLayer } = options;

  app.post("/api/entities/:name/onchange", async ({ params, body, set, request }) => {
    if (!entityRegistry || !commandLayer || !onchangeEvaluator) {
      return serviceUnavailable(
        set,
        "Onchange evaluator, entity registry, or command layer not configured.",
      );
    }

    const entityName = params.name;

    // Finding 1 — run the permission slot BEFORE revealing anything about the
    // shape of the entity or its onchange map. We must not leak "this entity
    // exists but you can't use it" vs "this entity doesn't exist" to an
    // unauthenticated probe, because the distinction would let callers
    // enumerate which entities have onchange hooks.
    //
    // We dispatch through CommandLayer first with only the target entity in
    // `meta.onchange` so permission middleware can decide. Existence /
    // field-shape validation happens AFTER the permission slot passes.
    const actor = await resolveActor(request, options.resolveRequestActor);
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value;
    }
    const incomingTraceId = request.headers.get("x-trace-id") ?? undefined;

    // Best-effort extraction of `changedField` for permission-slot metadata.
    // We do NOT validate the value yet — that happens after auth passes.
    // `changedField` is forwarded to permission middleware so ABAC / RBAC
    // rules can do field-level gating if they choose.
    const payload = (body ?? {}) as Record<string, unknown>;
    const rawChangedField = payload.changedField;
    const changedFieldForMeta = typeof rawChangedField === "string" ? rawChangedField : "";

    const commandResult = await commandLayer.execute({
      command: buildOnchangeCommandName(entityName),
      input: { entity: entityName, changedField: changedFieldForMeta },
      actor,
      channel: "http",
      headers,
      traceId: incomingTraceId,
      meta: {
        onchange: {
          entity: entityName,
          changedField: changedFieldForMeta,
        },
      },
      skipActionSlots: true,
    });

    if (!commandResult.success) {
      // Finding 1 — uniform auth/permission failure envelope. Do NOT branch on
      // whether the entity exists; the caller must not learn more from a
      // blocked response than "you're not authorized to use this endpoint".
      const status = resolveStatusCode(commandResult);
      set.status = status;
      const errData = commandResult.data as Record<string, unknown> | undefined;
      const middlewareMessage = (errData?.error as string) ?? "Onchange request blocked";
      const middlewareCode = (errData?.code as string) ?? "ONCHANGE.BLOCKED";

      // Non-blocker 4 — canonicalize the 401/403 envelope so the middleware's
      // entity-specific denial text cannot be used as a side channel to
      // enumerate which entities exist or are onchange-enabled. Log the raw
      // detail for operator debugging.
      if (status === 401 || status === 403) {
        consoleLogger.warn("onchange: authorization denied", {
          entity: entityName,
          changedField: changedFieldForMeta,
          actor: actor.id,
          status,
          middlewareCode,
          middlewareMessage,
        });
        return AUTHZ_DENIED_BODY;
      }

      return {
        success: false,
        error: { code: middlewareCode, message: middlewareMessage },
      };
    }

    // ── Post-auth: safe to reveal entity / field shape ────────────────
    const entity = entityRegistry.get(entityName);
    if (!entity) {
      return notFound(set, `Entity "${entityName}" not found.`);
    }
    if (!entity.onchange || Object.keys(entity.onchange).length === 0) {
      return notFound(set, `Entity "${entityName}" has no onchange definition.`);
    }

    if (typeof rawChangedField !== "string" || rawChangedField.length === 0) {
      return badRequest(set, "Request body must include a non-empty string `changedField`.");
    }
    if (!(rawChangedField in entity.fields)) {
      return badRequest(
        set,
        `Field "${rawChangedField}" is not defined on entity "${entityName}".`,
      );
    }

    // Finding 2 — reject malformed `values` explicitly. Arrays, strings,
    // numbers, null, etc. previously coerced to `{}`, silently masking caller
    // bugs. Only plain objects are valid.
    const rawValues = payload.values;
    let values: Record<string, unknown>;
    if (rawValues === undefined) {
      values = {};
    } else if (typeof rawValues === "object" && rawValues !== null && !Array.isArray(rawValues)) {
      values = rawValues as Record<string, unknown>;
    } else {
      set.status = 400;
      return {
        success: false,
        error: {
          code: "INVALID_REQUEST.MALFORMED_VALUES",
          message: "`values` must be a plain object when provided.",
        },
      };
    }
    const changedField = rawChangedField;

    // Now run the evaluator. The CommandLayer has already authorized this
    // request; the evaluator only handles pure computation + permission-scoped
    // lookups via the DataProvider.
    //
    // The synthetic success result from `skipActionSlots` carries the resolved
    // `actor` / `tenantId` / `locale` read from the command context after the
    // auth + tenant middlewares ran. Spec 64 §9.1 mandates that onchange runs
    // with the caller's resolved permissions — auth middleware that enriches
    // the actor (role hydration, impersonation) MUST be honored here, so we
    // prefer the post-pipeline actor over the actor we resolved from the
    // request before dispatch.
    const resolvedContext =
      commandResult.data && typeof commandResult.data === "object"
        ? (commandResult.data as {
            actor?: typeof actor;
            tenantId?: string;
            locale?: string;
          })
        : undefined;
    try {
      const result = await onchangeEvaluator.evaluate({
        entityName,
        changedField,
        values,
        actor: resolvedContext?.actor ?? actor,
        tenantId: resolvedContext?.tenantId,
      });
      return {
        updates: result.updates,
        warnings: result.warnings,
      };
    } catch (err) {
      if (err instanceof OnchangeEvaluatorError) {
        if (
          err.code === "ENTITY_NOT_FOUND" ||
          err.code === "ENTITY_HAS_NO_ONCHANGE" ||
          err.code === "NO_HOOK_FOR_FIELD"
        ) {
          return notFound(set, err.message);
        }
        // FIELD_UNKNOWN
        return badRequest(set, err.message);
      }
      const message = err instanceof Error ? err.message : "Onchange evaluation failed";
      return serverError(set, message);
    }
  });
}
