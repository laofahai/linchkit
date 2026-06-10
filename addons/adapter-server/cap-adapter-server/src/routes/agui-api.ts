/**
 * AG-UI run route — `POST /api/agui/run` on the MAIN server (:3001).
 *
 * cap-adapter-ag-ui owns the protocol endpoint (validation, SSE framing,
 * RUN_* lifecycle); this module mounts its handler on the adapter-server app
 * so the admin UI reaches it through the regular `/api` proxy, and injects
 * the full-assistant runner (ai/agui-runner.ts) so the AG-UI transport keeps
 * feature parity with `/api/ai/chat` (system prompt, server-side tools,
 * multi-step).
 *
 * Mounted ONLY when the `cap-adapter-ag-ui` capability is registered in the
 * project's capability list — registration is the opt-in. The addon package
 * is a lazily-imported optional peer (same pattern as cap-ai-provider): the
 * import happens on first request, and since the capability can only be
 * registered by importing the package, the import cannot miss.
 */

import type { AgUiRunHandler } from "@linchkit/cap-adapter-ag-ui";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";

/** Capability name whose registration opts the run route in. */
export const AG_UI_CAPABILITY_NAME = "cap-adapter-ag-ui";

/** Path the run route is mounted under on the main server. */
export const AG_UI_RUN_PATH = "/api/agui/run";

/** Whether the AG-UI capability is registered (drives route mounting). */
export function hasAgUiCapability(options: Pick<ServerOptions, "capabilities">): boolean {
  return (options.capabilities ?? []).some((cap) => cap.name === AG_UI_CAPABILITY_NAME);
}

/**
 * Mount `POST /api/agui/run` when cap-adapter-ag-ui is registered.
 *
 * The handler is built lazily on first request (mirrors ai-api.ts's lazy
 * imports) and cached. When `aiConfig` is present the full-assistant runner
 * is injected; without it the addon's default AIService bridge applies —
 * same degradation `/api/ai/chat` has (it 503s without aiConfig; the bridge
 * still streams plain completions).
 */
export function mountAgUiRoutes(app: Elysia, options: ServerOptions): Elysia {
  if (!hasAgUiCapability(options)) return app;

  let handler: AgUiRunHandler | undefined;

  app.post(AG_UI_RUN_PATH, async ({ body, set, request }) => {
    if (!handler) {
      const { createAgUiRunHandler } = await import("@linchkit/cap-adapter-ag-ui");
      const runner = options.aiConfig
        ? (await import("../ai/agui-runner")).createAssistantAgUiRunner(options)
        : undefined;
      handler = createAgUiRunHandler({ aiService: options.aiService, runner });
    }
    return handler({ body, set, request });
  });

  return app;
}
