/**
 * Shared fixtures for the onchange-evaluator test suite (Spec 64).
 *
 * The suite is split across multiple files by concern — see:
 *   - onchange-evaluator-core.test.ts        (BFS, chaining, cycles)
 *   - onchange-evaluator-permissions.test.ts (checkReadPermission + dedup)
 *   - onchange-evaluator-errors.test.ts      (timeouts, sanitation, mutation)
 *   - onchange-evaluator-validation.test.ts  (structured error codes)
 *
 * Anything needed by more than one file lives here.
 */

import type { DataProvider } from "../src/engine/action-engine";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { Actor } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import type { Logger } from "../src/types/logger";

/** Standard non-admin actor used by every test. */
export const ACTOR: Actor = { type: "human", id: "u1", groups: ["user"] };

/** Captured logger invocation used by sanitation-focused tests. */
export interface LoggerCall {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Spy logger that records every call. Used by the Finding 4 sanitation tests
 * to assert that raw internal errors are routed to the server log rather than
 * leaked into the client-visible warnings array.
 */
export function createSpyLogger(): { logger: Logger; calls: LoggerCall[] } {
  const calls: LoggerCall[] = [];
  const make =
    (level: LoggerCall["level"]) => (message: string, context?: Record<string, unknown>) => {
      calls.push({ level, message, context });
    };
  return {
    calls,
    logger: {
      debug: make("debug"),
      info: make("info"),
      warn: make("warn"),
      error: make("error"),
    },
  };
}

/** Minimal in-memory data provider for lookup/query tests. */
export function createStubDataProvider(seed?: {
  records?: Record<string, Record<string, Record<string, unknown>>>;
}): DataProvider {
  const store = seed?.records ?? {};
  return {
    async get(entity, id) {
      const rec = store[entity]?.[id];
      if (!rec) throw new Error(`Record ${entity}/${id} not found`);
      return rec;
    },
    async query(entity, filter) {
      const table = store[entity];
      if (!table) return [];
      return Object.values(table).filter((r) =>
        Object.entries(filter).every(([k, v]) => r[k] === v),
      );
    },
    async create() {
      throw new Error("DataProvider.create must not be called from onchange");
    },
    async update() {
      throw new Error("DataProvider.update must not be called from onchange");
    },
    async delete() {
      throw new Error("DataProvider.delete must not be called from onchange");
    },
    async count() {
      throw new Error("not used");
    },
  };
}

/**
 * Failing data provider whose get/query always reject with the same error.
 * Used by tests that exercise lookup/query error surfacing and sanitation.
 */
export function createFailingDataProvider(message: string): DataProvider {
  return {
    async get() {
      throw new Error(message);
    },
    async query() {
      throw new Error(message);
    },
    async create() {
      throw new Error("not used");
    },
    async update() {
      throw new Error("not used");
    },
    async delete() {
      throw new Error("not used");
    },
    async count() {
      throw new Error("not used");
    },
  };
}

/** Build an EntityRegistry seeded with a single entity definition. */
export function registerEntity(entity: EntityDefinition) {
  const reg = createEntityRegistry();
  reg.register(entity);
  return reg;
}
