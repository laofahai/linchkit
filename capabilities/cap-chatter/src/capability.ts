/**
 * cap-chatter capability definition
 *
 * Unified record timeline: message storage, auto-audit, GraphQL API.
 * Implements Spec 53 MVP scope.
 */

import { defineCapability } from "@linchkit/core";
import type { CapabilityDefinition } from "@linchkit/core";
import { createChatterAutoLog } from "./event-handler";
import { InMemoryChatterService, DrizzleChatterService } from "./service";
import type { ChatterService } from "./types";

// ── Capability options ──────────────────────────────────────

export interface CapChatterOptions {
  /**
   * Drizzle database instance for persistent storage.
   * When omitted, falls back to in-memory storage (dev/test only).
   */
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB type varies by driver
  db?: any;
  /**
   * Pre-built ChatterService instance.
   * When provided, `db` is ignored.
   */
  service?: ChatterService;
}

// ── Factory ──────────────────────────────────────────────────

/**
 * Create a fully-wired cap-chatter capability.
 *
 * @example
 * ```ts
 * import { createCapChatter } from "@linchkit/cap-chatter"
 * const capChatter = createCapChatter({ db })
 * ```
 */
export function createCapChatter(options?: CapChatterOptions): CapabilityDefinition & {
  chatterService: ChatterService;
} {
  const service: ChatterService =
    options?.service ??
    (options?.db ? new DrizzleChatterService(options.db) : new InMemoryChatterService());

  const autoLogHandler = createChatterAutoLog(service);

  const capability = defineCapability({
    name: "cap-chatter",
    label: "Chatter",
    description:
      "Unified record timeline: message storage, field-level audit log, and real-time updates. " +
      "Implements Spec 53 MVP.",
    type: "standard",
    category: "system",
    version: "0.1.0",

    eventHandlers: [autoLogHandler],

    extensions: {
      services: [
        {
          name: "chatter",
          factory: () => service,
        },
      ],
    },
  });

  return Object.assign(capability, { chatterService: service });
}

/** Static (no-DB) capability export for registries that just need the definition shape */
export const capChatter = createCapChatter();
