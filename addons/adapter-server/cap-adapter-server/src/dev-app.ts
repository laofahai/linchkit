/**
 * Dev app factory — the server-bridge half of the dev/boot path.
 *
 * `assemble-schema.ts` builds the GraphQL schema + runtime context but stays
 * deliberately server-free. `dev.ts` then inlines the bridge that hands that
 * runtime to `createServer(...)` and binds a port. Because nothing exercised
 * THAT bridge outside of actually starting the listening HTTP server, an HTTP
 * wiring regression (e.g. a route module crashing on the in-memory runtime, or
 * `createServer` mis-wiring `entityRegistry`/`dataProvider`) could ship
 * undetected and only surface at `bun run dev:server`.
 *
 * This module extracts that bridge into a reusable, exported, DB-free and
 * port-free factory: `createDevApp(capabilities, options?)` returns a ready
 * Elysia app whose requests can be dispatched in-process via
 * `app.handle(new Request(...))` — no `listen()`, no socket, no Postgres.
 *
 * It mirrors `dev.ts`'s `createServer(...)` call exactly (same option mapping)
 * so the boot smoke test and the real dev server share one wiring path.
 */

import type { CapabilityDefinition } from "@linchkit/core";
import {
  type AssembleDevSchemaOptions,
  type AssembledDevSchema,
  assembleDevSchema,
} from "./assemble-schema";
import { createServer, type ServerOptions } from "./server";

/** Options for {@link createDevApp}. */
export interface CreateDevAppOptions extends AssembleDevSchemaOptions {
  /**
   * CORS origin configuration forwarded to `createServer`. Defaults to the
   * dev localhost origins. Tests can pass `false` to disable CORS entirely.
   */
  cors?: ServerOptions["cors"];
}

/** Result of {@link createDevApp}: the Elysia app plus the assembled schema. */
export interface DevApp {
  /**
   * The Elysia app. Use `await app.handle(new Request(url, init))` to dispatch
   * requests in-process without binding a port, or `app.listen(port)` to serve.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Elysia plugin chaining produces complex inferred types — `createServer` returns `any` for the same reason.
  app: any;
  /** The assembled schema + runtime context that backs the app. */
  assembled: AssembledDevSchema;
}

/**
 * Build a ready-to-serve dev Elysia app from a set of capabilities.
 *
 * This is the exact path `bun run dev:server` exercises — `assembleDevSchema`
 * then `createServer` with the runtime wired in — minus loading config and
 * binding a port. DB-free: with no `dataProvider`, `assembleDevSchema` falls
 * back to `InMemoryStore`, so this runs in CI without Postgres.
 *
 * @param capabilities - Capabilities to assemble (adapter + business + system).
 * @param options - Optional AI service and CORS configuration.
 * @returns The Elysia app and the assembled schema/runtime that backs it.
 */
export function createDevApp(
  capabilities: CapabilityDefinition[],
  options?: CreateDevAppOptions,
): DevApp {
  const assembled = assembleDevSchema(capabilities, { aiService: options?.aiService });
  const { schema, runtime, contributions, onchangeEvaluator } = assembled;

  // Mirror dev.ts's createServer(...) call exactly so the boot smoke test and
  // the real dev server share one wiring path.
  const app = createServer(schema, {
    executor: runtime.executor,
    commandLayer: runtime.commandLayer,
    executionLogger: runtime.executionLogger,
    entityRegistry: runtime.entityRegistry,
    views: runtime.views,
    capabilities,
    rules: contributions.rules,
    aiService: runtime.ai,
    states: contributions.states,
    flows: [],
    dataProvider: runtime.dataProvider,
    onchangeEvaluator,
    ...(options?.cors !== undefined && { cors: options.cors }),
  });

  return { app, assembled };
}
