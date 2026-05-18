/**
 * Deployment webhook endpoint — Spec 12 §3
 *
 * POST /api/deploy/webhook
 *   Receives GitHub push events, verifies the HMAC-SHA256 signature,
 *   and fires the deploy callback when a push to the watched branch lands.
 *
 * Required headers:
 *   X-Hub-Signature-256: sha256=<hex>   — GitHub webhook signature
 *   X-GitHub-Event: push                — event type
 *
 * Response codes:
 *   200 — accepted and deploy callback invoked
 *   400 — missing headers or invalid JSON
 *   403 — signature verification failed
 *   503 — no webhook handler configured
 */

import type { DeployWebhookHandler } from "@linchkit/core/server";
import type { Elysia } from "elysia";

export function mountDeployRoutes(app: Elysia, handler: DeployWebhookHandler | undefined): void {
  if (!handler) {
    // Route is still registered so callers get 503 instead of 404
    app.post("/api/deploy/webhook", ({ set }) => {
      set.status = 503;
      return { success: false, error: "Deploy webhook handler not configured" };
    });
    return;
  }

  app.post("/api/deploy/webhook", async ({ request, set }) => {
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    const eventType = request.headers.get("x-github-event") ?? "";

    if (!signature) {
      set.status = 400;
      return { success: false, error: "Missing X-Hub-Signature-256 header" };
    }
    if (!eventType) {
      set.status = 400;
      return { success: false, error: "Missing X-GitHub-Event header" };
    }

    const rawBody = await request.text();

    const result = await handler.handle(rawBody, signature, eventType);

    if (!result.accepted) {
      // Signature failure → 403; other skip reasons (wrong branch, event type) → 200
      if (result.reason === "invalid signature") {
        set.status = 403;
        return { success: false, error: "Signature verification failed" };
      }
      // Not an error — GitHub may send many event types; we just skip non-push
      return { success: true, accepted: false, reason: result.reason };
    }

    return { success: true, accepted: true };
  });
}
