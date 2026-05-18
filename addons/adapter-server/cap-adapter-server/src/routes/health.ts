/**
 * Liveness + readiness probes (Spec 12 — deployment foundation).
 *
 * - `GET /health` — process liveness. Always returns 200 with `{ status,
 *   uptime, version }`. Used by container orchestrators to decide whether
 *   to restart the process. MUST be cheap and free of external side
 *   effects: it answers "is the process running?", not "can we serve
 *   traffic?".
 *
 * - `GET /ready` — readiness. Returns 200 once the server can accept
 *   traffic, 503 otherwise. Currently the only readiness signal is the
 *   data provider: if a Drizzle provider is wired, `ping()` must succeed;
 *   if an in-memory provider is wired (dev / test), readiness is implicit.
 *   When no data provider is configured, the server is considered ready
 *   (degraded read-only modes are still serviceable).
 *
 * Both endpoints bypass CommandLayer auth — they are infrastructure level
 * and must remain reachable even when the auth capability is down.
 *
 * Registered in `server.ts` AFTER `mountAdminRoutes` so that any duplicate
 * `/health` handler in admin-api is overridden by this canonical, minimal
 * liveness response. The richer aggregated health snapshot stays available
 * via the other observability endpoints (`/api/metrics`, `/api/settings`).
 */

import { DrizzleDataProvider } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";

/** Server version surfaced by `/health`. Kept in sync with other admin endpoints. */
const SERVER_VERSION = "0.2.0";

/**
 * Mount liveness + readiness probes.
 *
 * @param app - The Elysia app to attach routes to.
 * @param options - Server options (used to discover the data provider).
 */
export function mountHealthRoutes(app: Elysia, options: ServerOptions): void {
  const dataProvider = options.dataProvider;

  app
    // Liveness: always 200 — answers "is the process alive?"
    // Response shape matches the legacy `/health` contract consumed by
    // existing tests and dashboards: `{ status: "healthy", timestamp, checks }`.
    .get("/health", () => {
      return {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: SERVER_VERSION,
        checks: { process: { ok: true } },
      };
    })
    // Readiness: 200 when dependencies are reachable, 503 otherwise.
    .get("/ready", async ({ set }) => {
      const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

      if (dataProvider instanceof DrizzleDataProvider) {
        let ok = false;
        let detail: string | undefined;
        try {
          ok = await dataProvider.ping();
          if (!ok) {
            detail = "Database ping returned false";
          }
        } catch (err) {
          detail = err instanceof Error ? err.message : String(err);
        }
        checks.push({ name: "database", ok, ...(detail !== undefined && { detail }) });
      } else if (dataProvider) {
        // In-memory or custom data provider — assume ready, but record it.
        checks.push({ name: "database", ok: true, detail: "non-drizzle provider" });
      } else {
        checks.push({ name: "database", ok: true, detail: "no data provider configured" });
      }

      const ready = checks.every((c) => c.ok);
      if (!ready) {
        set.status = 503;
      }
      return {
        status: ready ? "ready" : "not_ready",
        checks,
        timestamp: new Date().toISOString(),
      };
    });
}
