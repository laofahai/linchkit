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
import type { AssistantAgUiRunnerOptions } from "../ai/agui-runner";
import type { ServerOptions } from "../server";

/** Capability name whose registration opts the run route in. */
export const AG_UI_CAPABILITY_NAME = "cap-adapter-ag-ui";

/** Path the run route is mounted under on the main server. */
export const AG_UI_RUN_PATH = "/api/agui/run";

/** Path the HITL capability discovery surface is mounted under (Spec 71 P5 §3.5). */
export const AG_UI_CAPABILITIES_PATH = "/api/agui/capabilities";

/**
 * Env flag that wires a DETERMINISTIC stub model into the AG-UI runner for the
 * browser e2e (Spec 71 P5 §8 / CI reliability). When set to "1", the runner uses
 * a `MockLanguageModelV3` that always calls `proposeMutation{create_product,…}`
 * instead of a live provider — so the browser e2e proves the UI render → click →
 * resume → record chain reliably, not the model's decision to propose. NEVER set
 * on a real deployment (the only caller is the e2e's server boot env).
 */
export const AG_UI_STUB_MODEL_ENV = "LINCHKIT_AGUI_STUB_MODEL";

/** Whether the AG-UI capability is registered (drives route mounting). */
export function hasAgUiCapability(options: Pick<ServerOptions, "capabilities">): boolean {
  return (options.capabilities ?? []).some((cap) => cap.name === AG_UI_CAPABILITY_NAME);
}

/**
 * Build the HITL runner options, wiring the deterministic stub model ONLY when
 * the e2e env flag is set (Spec 71 P5 §8). Kept tiny + pure so the env gate is
 * the single decision point; the stub itself lives in `../ai/agui-e2e-stub`
 * (imported lazily so `ai/test` never loads on a real boot).
 */
async function buildHitlRunnerOptions(): Promise<AssistantAgUiRunnerOptions> {
  if (process.env[AG_UI_STUB_MODEL_ENV] !== "1") return {};
  const { buildProposeMutationStubModel } = await import("../ai/agui-e2e-stub");
  return { modelOverride: buildProposeMutationStubModel() };
}

/**
 * Mount the AG-UI routes when cap-adapter-ag-ui is registered:
 *  - `POST /api/agui/run` — the run/resume endpoint (full-assistant runner).
 *  - `GET  /api/agui/capabilities` — the HITL discovery surface (Spec 71 P5 §3.5).
 *
 * The run handler is built lazily on first request (mirrors ai-api.ts's lazy
 * imports) and cached. When `aiConfig` is present the full-assistant runner
 * is injected; without it the addon's default AIService bridge applies —
 * same degradation `/api/ai/chat` has (it 503s without aiConfig; the bridge
 * still streams plain completions). The capabilities surface has no AI/runner
 * dependency, so it answers even when the provider is unconfigured.
 */
export function mountAgUiRoutes(app: Elysia, options: ServerOptions): Elysia {
  if (!hasAgUiCapability(options)) return app;

  let handler: AgUiRunHandler | undefined;

  app.post(AG_UI_RUN_PATH, async ({ body, set, request }) => {
    if (!handler) {
      const { createAgUiRunHandler } = await import("@linchkit/cap-adapter-ag-ui");
      const runner = options.aiConfig
        ? (await import("../ai/agui-runner")).createAssistantAgUiRunner(
            options,
            await buildHitlRunnerOptions(),
          )
        : undefined;
      handler = createAgUiRunHandler({ aiService: options.aiService, runner });
    }
    return handler({ body, set, request });
  });

  // HITL capability discovery (Spec 71 P5 §3.5). Static JSON from the addon's
  // canonical `ASSISTANT_HITL_CAPABILITIES` (schema-validated at build time), so
  // a conformant AG-UI client can discover that this endpoint emits interrupt
  // outcomes + accepts resume[]. Built lazily + cached like the run handler.
  let capabilitiesBody: unknown;
  app.get(AG_UI_CAPABILITIES_PATH, async () => {
    if (capabilitiesBody === undefined) {
      const { buildAgUiCapabilities } = await import("@linchkit/cap-adapter-ag-ui");
      capabilitiesBody = buildAgUiCapabilities();
    }
    return capabilitiesBody;
  });

  return app;
}
