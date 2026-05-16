/**
 * Default `EventReplayService` factory for the `linch events` command group.
 *
 * Split from `events.ts` so the command file can focus on rendering and stay
 * under the project's 500 LOC limit. Tests override the factory in `events.ts`
 * via `setServiceFactory`, so this module is reached only by the live CLI.
 */

import type { CapabilityDefinition, EventHandlerDefinition, LinchKitConfig } from "@linchkit/core";
import type { EventHandlerRegistry, EventReplayService } from "@linchkit/core/server";
import { loadConfig } from "../utils/load-config";
import { collectCapabilityDefinitions } from "./startup/collect-capabilities";

export interface ServiceHandle {
  service: EventReplayService;
  /** Populated when the factory was asked to bootstrap handlers; empty otherwise. */
  registry: EventHandlerRegistry;
  cleanup: () => Promise<void>;
}

export type ServiceFactory = (options: { needsRegistry: boolean }) => Promise<ServiceHandle>;

/**
 * Default factory — boots a real EventReplayService backed by DATABASE_URL.
 * When `needsRegistry` is true, capability `eventHandlers` arrays from
 * `linchkit.config.ts` are registered on a fresh `EventHandlerRegistry` so
 * replay invocations dispatch to the same handlers a normal delivery would
 * hit (Spec 66 §4 — replay must not silently drop registered handlers).
 */
export async function defaultServiceFactory(options: {
  needsRegistry: boolean;
}): Promise<ServiceHandle> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required. Set it in your environment.");
  }

  const { closeDatabase, createDatabase, EventHandlerRegistry, createEventReplayService } =
    await import("@linchkit/core/server");

  const db = createDatabase({ url: dbUrl });
  const registry = new EventHandlerRegistry();

  if (options.needsRegistry) {
    let config: LinchKitConfig = {};
    try {
      const loaded = await loadConfig();
      config = loaded.config;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load linchkit.config.ts: ${msg}`);
    }
    const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];
    const collected = collectCapabilityDefinitions(capabilities);
    for (const handler of collected.eventHandlers as EventHandlerDefinition[]) {
      if (!registry.get(handler.name)) {
        registry.register(handler);
      }
    }
  }

  const service = createEventReplayService({ db, registry });
  return { service, registry, cleanup: () => closeDatabase() };
}
