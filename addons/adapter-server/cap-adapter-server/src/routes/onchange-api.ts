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
import { OnchangeEvaluatorError } from "@linchkit/core/server";
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
    const entity = entityRegistry.get(entityName);
    if (!entity) {
      return notFound(set, `Entity "${entityName}" not found.`);
    }
    if (!entity.onchange || Object.keys(entity.onchange).length === 0) {
      return notFound(set, `Entity "${entityName}" has no onchange definition.`);
    }

    // Parse body
    const payload = (body ?? {}) as Record<string, unknown>;
    const changedField = payload.changedField;
    const rawValues = payload.values;

    if (typeof changedField !== "string" || changedField.length === 0) {
      return badRequest(set, "Request body must include a non-empty string `changedField`.");
    }
    if (!(changedField in entity.fields)) {
      return badRequest(set, `Field "${changedField}" is not defined on entity "${entityName}".`);
    }
    const values =
      rawValues && typeof rawValues === "object" && !Array.isArray(rawValues)
        ? (rawValues as Record<string, unknown>)
        : {};

    // Dispatch through CommandLayer with skipActionSlots. The synthetic command
    // name exists only so metrics / tracing have a stable label.
    const actor = await resolveActor(request, options.resolveRequestActor);
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value;
    }
    const incomingTraceId = request.headers.get("x-trace-id") ?? undefined;

    const commandResult = await commandLayer.execute({
      command: buildOnchangeCommandName(entityName),
      input: { entity: entityName, changedField },
      actor,
      channel: "http",
      headers,
      traceId: incomingTraceId,
      meta: {
        onchange: {
          entity: entityName,
          changedField,
        },
      },
      skipActionSlots: true,
    });

    if (!commandResult.success) {
      set.status = resolveStatusCode(commandResult);
      const errData = commandResult.data as Record<string, unknown> | undefined;
      const message = (errData?.error as string) ?? "Onchange request blocked";
      const code = (errData?.code as string) ?? "ONCHANGE.BLOCKED";
      return {
        success: false,
        error: { code, message },
      };
    }

    // Now run the evaluator. The CommandLayer has already authorized this
    // request; the evaluator only handles pure computation + permission-scoped
    // lookups via the DataProvider.
    try {
      const result = await onchangeEvaluator.evaluate({
        entityName,
        changedField,
        values,
        actor,
        tenantId:
          commandResult.data && typeof commandResult.data === "object"
            ? (commandResult.data as { tenantId?: string }).tenantId
            : undefined,
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
