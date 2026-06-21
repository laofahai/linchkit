/**
 * Core route-module mounting, extracted from `server.ts` to keep that
 * entrypoint under the repo's 500-line ceiling. These are the order-sensitive,
 * closure-free route mounts — each takes only `(app, opts)` (plus
 * `serverStartedAt` for admin). The remaining mounts that close over server-
 * local state (overlay → schema hot-reload, graphql-yoga, deploy, proposal /
 * evolution / subscription) stay inline in `server.ts`.
 *
 * Mount ORDER is significant and preserved verbatim from the original site:
 *  - health AFTER admin so the canonical `/health` (Spec 12) overrides any
 *    duplicate admin handler;
 *  - resolveIntent AFTER the AI routes so the canonical handler wins routing.
 */

import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { mountActionRoutes } from "./action-api";
import { mountAdminRoutes } from "./admin-api";
import { mountAgUiRoutes } from "./agui-api";
import { mountAIRoutes } from "./ai-api";
import { mountAIByokRoutes } from "./ai-byok";
import { mountResolveIntentRoute } from "./ai-resolve-intent";
import { mountResolveSchemaIntentRoute } from "./ai-resolve-schema-intent";
import { mountAITracesRoutes } from "./ai-traces-api";
import { mountApprovalRoutes } from "./approval-api";
import { mountConfigRoutes } from "./config-api";
import { mountConfigStoreRoutes } from "./config-store-api";
import { mountEntityRoutes } from "./entity-api";
import { mountHealthRoutes } from "./health";
import { mountImportRoutes } from "./import-api";
import { mountOnchangeRoutes } from "./onchange-api";
import { mountProposalsFromNoteRoute } from "./proposals-from-note";
import { mountTranslationRoutes } from "./translation-api";

/** Mount the order-sensitive, closure-free core route modules onto `app`. */
export function mountCoreRoutes(app: Elysia, opts: ServerOptions, serverStartedAt: number): void {
  mountAdminRoutes(app, opts, serverStartedAt);
  // Mounted AFTER admin so the canonical, minimal `/health` (Spec 12 — liveness)
  // overrides any duplicate handler in admin-api.ts. `/ready` is exclusive to
  // this module.
  mountHealthRoutes(app, opts);
  mountEntityRoutes(app, opts);
  mountActionRoutes(app, opts);
  mountImportRoutes(app, opts);
  mountApprovalRoutes(app, opts);
  mountConfigRoutes(app, opts);
  mountConfigStoreRoutes(app, opts);
  mountAIRoutes(app, opts);
  // AG-UI protocol run endpoint (#89) — only mounts when cap-adapter-ag-ui
  // is registered in the capability list. Bridges the same assistant brain
  // as POST /api/ai/chat onto official AG-UI events over SSE.
  mountAgUiRoutes(app, opts);
  // Spec 36 M2+ BYOK + usage endpoints (per-tenant key store + meter).
  // Mounted alongside the other AI routes; no-ops when the store /
  // meter are not configured (returns 503 with a structured envelope).
  mountAIByokRoutes(app, opts);
  // Spec 52 §2.6 canonical intent-resolution endpoint. Mounted AFTER
  // mountAIRoutes so the canonical handler (with permission scoping +
  // audit logging) wins routing for `POST /api/ai/resolve-intent` if any
  // legacy handler is left in the file.
  mountResolveIntentRoute(app, opts);
  // Spec 69 P3 wave 2 — admin read of recent AI traces (`GET /api/ai/traces`),
  // permission-gated through CommandLayer (`meta.aiObservability`).
  mountAITracesRoutes(app, opts);
  // Spec 52 "说→有" first slice — NL utterance → governed `add_rule` ProposalDraft.
  mountResolveSchemaIntentRoute(app, opts);
  // 经验→制度 (first segment) — human-gated promotion of a chatter note (经验) into
  // a DRAFT governed Proposal carrying the note as `evidence` provenance. Reuses
  // the same NL → proposal pipeline as the sibling route above.
  mountProposalsFromNoteRoute(app, opts);
  mountTranslationRoutes(app, opts);
  mountOnchangeRoutes(app, opts, opts.onchangeEvaluator);
}
