/**
 * Restate connection manager
 *
 * Creates and manages a Restate HTTP endpoint that hosts compiled workflow services.
 * Handles deployment registration with the Restate admin API and health checks.
 *
 * Restate SDK types are confined to this module — they should not leak
 * to other parts of the codebase.
 */

import * as restate from "@restatedev/restate-sdk";
import type { RestateConfig } from "./types";

// ── Defaults ────────────────────────────────────────────

const DEFAULT_ADMIN_URL = "http://localhost:9070";
const DEFAULT_SERVICE_PORT = 9080;

// ── RestateEndpoint wrapper ─────────────────────────────

export interface RestateEndpoint {
  /** Bind a compiled workflow service to this endpoint */
  bind(service: unknown): RestateEndpoint;

  /** Start listening on the configured port */
  listen(port?: number): Promise<void>;

  /** Graceful shutdown */
  stop(): Promise<void>;
}

/**
 * Create and start a Restate HTTP endpoint that hosts compiled workflow services.
 * Uses @restatedev/restate-sdk's endpoint().listen() pattern.
 */
export function createRestateEndpoint(config: RestateConfig = {}): RestateEndpoint {
  const port = config.servicePort ?? DEFAULT_SERVICE_PORT;
  const inner = restate.endpoint();

  let server: { close(): void } | null = null;

  const wrapper: RestateEndpoint = {
    bind(service: unknown) {
      // The Restate SDK accepts VirtualObjectDefinition | WorkflowDefinition | ServiceDefinition
      // We use `unknown` in our public API to avoid leaking Restate types.
      inner.bind(service as Parameters<typeof inner.bind>[0]);
      return wrapper;
    },

    async listen(overridePort?: number) {
      const listenPort = overridePort ?? port;
      // endpoint().listen() returns a promise that resolves to an HTTP server
      server = await (inner.listen(listenPort) as unknown as Promise<{ close(): void }>);
    },

    async stop() {
      if (server) {
        server.close();
        server = null;
      }
    },
  };

  return wrapper;
}

// ── Deployment registration ─────────────────────────────

/**
 * Register a deployment with the Restate admin API.
 * POST to {adminUrl}/deployments with the service endpoint URI.
 *
 * This tells Restate where to find the workflow service so it can
 * route invocations to it.
 */
export async function registerDeployment(adminUrl: string, serviceUri: string): Promise<void> {
  const url = `${adminUrl.replace(/\/$/, "")}/deployments`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uri: serviceUri }),
  });

  if (!response.ok) {
    // 409 Conflict means deployment already registered — that's fine
    if (response.status === 409) {
      return;
    }
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to register deployment with Restate (${response.status}): ${body}`);
  }
}

// ── Health check ────────────────────────────────────────

/**
 * Health check — verify Restate server is reachable.
 * Pings the admin API health endpoint.
 */
export async function checkRestateHealth(adminUrl?: string): Promise<boolean> {
  const base = (adminUrl ?? DEFAULT_ADMIN_URL).replace(/\/$/, "");

  try {
    const response = await fetch(`${base}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    // Network error or timeout — Restate server is not reachable
    return false;
  }
}

// ── Convenience: auto-setup ─────────────────────────────

/**
 * Full setup helper: create endpoint, start listening, and optionally
 * register the deployment with the Restate admin API.
 *
 * @returns The running RestateEndpoint (call .stop() for graceful shutdown).
 */
export async function setupRestateEndpoint(
  config: RestateConfig,
  services: unknown[],
): Promise<RestateEndpoint> {
  const ep = createRestateEndpoint(config);

  for (const svc of services) {
    ep.bind(svc);
  }

  const port = config.servicePort ?? DEFAULT_SERVICE_PORT;
  await ep.listen(port);

  if (config.autoRegister !== false) {
    const adminUrl = config.adminUrl ?? DEFAULT_ADMIN_URL;
    const serviceUri = `http://localhost:${port}`;

    // Best-effort registration — don't fail startup if admin is temporarily unavailable
    try {
      await registerDeployment(adminUrl, serviceUri);
    } catch (err) {
      console.warn(
        `[LinchKit] Could not register Restate deployment: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return ep;
}
