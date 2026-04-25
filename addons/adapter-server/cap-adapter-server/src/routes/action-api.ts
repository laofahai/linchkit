/**
 * REST action endpoint.
 *
 * - POST /api/actions/batch — execute multiple actions via CommandLayer.executeBatch (Spec 16 §3.1)
 * - POST /api/actions/:name — execute a single action via ActionExecutor or CommandLayer
 *
 * Route ordering matters: `/api/actions/batch` MUST be registered before
 * `/api/actions/:name` so the parametric route does not capture "batch".
 */

import type {
  ActionResult,
  BatchActionsInput,
  BatchActionsResult,
  BatchTransactionStrategy,
} from "@linchkit/core";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import {
  badRequest,
  isMetaHeaderFailure,
  parseMetaHeader,
  resolveActor,
  resolveRequestLocale,
  resolveStatusCode,
  serverError,
} from "./shared";

/**
 * In production mode, replace per-item `error.message` strings with a
 * generic placeholder to avoid leaking internal details (driver errors,
 * stack-trace fragments, etc.) over HTTP. Codes and field locators are
 * preserved so clients can still differentiate validation vs. permission
 * failures. `rolledBack` items are successes (no error message), so they
 * are passed through untouched.
 *
 * Mirrors the single-action sanitization at the bottom of `mountActionRoutes`
 * to keep dev-mode parity (full message visible) and prod-mode safety.
 */
function sanitizeBatchResult(result: BatchActionsResult): BatchActionsResult {
  const isDevMode = process.env.NODE_ENV !== "production";
  if (isDevMode) return result;
  return {
    ...result,
    failed: result.failed.map((f) => ({
      ...f,
      error: { ...f.error, message: "Action execution failed" },
    })),
  };
}

/** Validate the JSON body shape for `POST /api/actions/batch`. */
function parseBatchBody(
  body: unknown,
): { ok: true; input: BatchActionsInput } | { ok: false; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "Request body must be a JSON object." };
  }
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.actions)) {
    return { ok: false, reason: "`actions` must be an array." };
  }
  for (let i = 0; i < obj.actions.length; i++) {
    const item = obj.actions[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: `actions[${i}] must be an object.` };
    }
    const it = item as Record<string, unknown>;
    if (typeof it.name !== "string" || it.name.length === 0) {
      return { ok: false, reason: `actions[${i}].name must be a non-empty string.` };
    }
    if (
      it.input !== undefined &&
      (typeof it.input !== "object" || it.input === null || Array.isArray(it.input))
    ) {
      // Reject arrays explicitly: `typeof [] === "object"` would otherwise
      // pass through and get spread-cloned into `{0: ..., 1: ...}` downstream.
      return { ok: false, reason: `actions[${i}].input must be an object when present.` };
    }
  }
  if (obj.strategy !== undefined) {
    if (obj.strategy !== "all_or_nothing" && obj.strategy !== "partial") {
      return {
        ok: false,
        reason: "`strategy` must be 'all_or_nothing' or 'partial'.",
      };
    }
  }
  const actions = obj.actions.map((raw) => {
    const it = raw as Record<string, unknown>;
    return {
      name: it.name as string,
      input: (it.input as Record<string, unknown>) ?? {},
    };
  });
  const input: BatchActionsInput = { actions };
  if (obj.strategy !== undefined) {
    input.strategy = obj.strategy as BatchTransactionStrategy;
  }
  return { ok: true, input };
}

export function mountActionRoutes(app: Elysia, options: ServerOptions): void {
  const executor = options.executor;
  const commandLayer = options.commandLayer;
  const transactionManager = options.transactionManager;
  const resolveRequestActor = options.resolveRequestActor;

  app
    // Batch endpoint — must be registered BEFORE the `/:name` route so the
    // parametric matcher does not capture "batch". HTTP 200 is used for all
    // structured results in v1, including partial failures (consider 207
    // Multi-Status in a follow-up if downstream tooling benefits from it).
    .post("/api/actions/batch", async ({ body, set, request }) => {
      if (!commandLayer) {
        return serverError(
          set,
          "Batch action endpoint requires a CommandLayer to enforce permissions.",
        );
      }

      const parsed = parseBatchBody(body);
      if (!parsed.ok) {
        return badRequest(set, parsed.reason);
      }

      // Parse X-Linch-Meta once and apply to every batch item via
      // CommandBatchExecuteOptions.meta. Phase 1's executeBatch merges this
      // record with `batch.parentExecutionId` / `batch.index` per item.
      const metaResult = parseMetaHeader(request);
      if (isMetaHeaderFailure(metaResult)) {
        set.status = 400;
        return {
          success: false as const,
          error: {
            code: `META.PARSE.${metaResult.code}`,
            message: metaResult.message,
          },
        };
      }
      const meta = metaResult?.ok === true ? metaResult.meta : undefined;

      const locale = resolveRequestLocale(request);
      const actor = await resolveActor(request, resolveRequestActor);
      const incomingTraceId = request.headers.get("x-trace-id") ?? undefined;
      const headers: Record<string, string> = {};
      for (const [key, value] of request.headers.entries()) {
        headers[key] = value;
      }

      const result: BatchActionsResult = await commandLayer.executeBatch({
        input: parsed.input,
        actor,
        channel: "http",
        locale,
        headers,
        traceId: incomingTraceId,
        transactionManager,
        meta,
      });

      // v1 returns 200 for any structurally valid request — clients inspect
      // `success` and the per-item arrays. (Consider HTTP 207 Multi-Status
      // for `partial` mode with mixed outcomes in a follow-up.) In production
      // we strip per-item error messages to prevent internal-detail leakage,
      // matching the single-action route below.
      return sanitizeBatchResult(result);
    })
    // REST action endpoint — executes via ActionExecutor
    // Body is unwrapped action input (Stripe-style, see spec 16 §2.4)
    .post("/api/actions/:name", async ({ params, body, set, request }) => {
      if (!executor && !commandLayer) {
        set.status = 500;
        return {
          success: false,
          error: {
            code: "SYSTEM.SERVER.NOT_CONFIGURED",
            type: "system",
            message: "Action executor not configured.",
          },
        };
      }

      const input = (body as Record<string, unknown>) ?? {};

      // Resolve locale and actor from request
      const locale = resolveRequestLocale(request);
      const actor = await resolveActor(request, resolveRequestActor);
      // Accept external trace ID for distributed tracing propagation
      const incomingTraceId = request.headers.get("x-trace-id") ?? undefined;

      // Parse the optional X-Linch-Meta header (Spec 65 §3.1). Reject early
      // with a 400 on a malformed payload so the action engine never sees a
      // half-validated meta — its own size check still runs as a defense-in-
      // depth guard against system-key spoofing and serialization issues.
      const metaResult = parseMetaHeader(request);
      if (isMetaHeaderFailure(metaResult)) {
        set.status = 400;
        return {
          success: false as const,
          error: {
            code: `META.PARSE.${metaResult.code}`,
            message: metaResult.message,
          },
        };
      }
      const meta = metaResult?.ok === true ? metaResult.meta : undefined;

      // Use CommandLayer pipeline when available, otherwise direct executor
      let result: ActionResult;
      if (commandLayer) {
        // Extract headers for middleware use
        const headers: Record<string, string> = {};
        for (const [key, value] of request.headers.entries()) {
          headers[key] = value;
        }
        result = await commandLayer.execute({
          command: params.name,
          input,
          actor,
          channel: "http",
          locale,
          headers,
          traceId: incomingTraceId,
          meta,
        });
      } else {
        if (!executor) {
          set.status = 500;
          return {
            success: false,
            error: {
              code: "SYSTEM.SERVER.NOT_CONFIGURED",
              type: "system",
              message: "Action executor not configured.",
            },
          };
        }
        result = await executor.execute(params.name, input, actor, {
          channel: "http",
          locale,
          meta,
        });
      }

      if (result.success) {
        return {
          success: true,
          data: result.data,
          meta: { executionId: result.executionId },
        };
      }

      set.status = resolveStatusCode(result);
      const errData = result.data as Record<string, unknown> | undefined;
      const rawMessage = (errData?.error as string) ?? "Action execution failed";

      // In production, sanitize internal error details to prevent information leakage
      const isDevMode = process.env.NODE_ENV !== "production";
      const safeMessage = isDevMode ? rawMessage : "Action execution failed";

      return {
        success: false,
        error: {
          code: "ACTION.EXECUTION.FAILED",
          message: safeMessage,
          ...(isDevMode && errData?.details ? { details: errData.details } : {}),
        },
        meta: { executionId: result.executionId },
      };
    });
}
