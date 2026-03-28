/**
 * REST action endpoint.
 *
 * - POST /api/actions/:name — execute an action via ActionExecutor or CommandLayer
 */

import type { ActionResult } from "@linchkit/core";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { resolveActor, resolveRequestLocale, resolveStatusCode } from "./shared";

export function mountActionRoutes(app: Elysia, options: ServerOptions): void {
  const executor = options.executor;
  const commandLayer = options.commandLayer;
  const resolveRequestActor = options.resolveRequestActor;

  app
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
