/**
 * cap-vector-pgvector capability definition.
 *
 * Wires a {@link VectorStore} implementation into the capability DI surface
 * so downstream consumers (Spec 55 evolution, Spec 67 Meta-Model semantics,
 * Spec 53 Chatter RAG …) can `ctx.services.get("vectorStore")` to obtain it.
 *
 * The host application decides whether to back the store with PostgreSQL
 * (`PgVectorStore`) or the in-memory brute-force store
 * (`InMemoryVectorStore`, dev/test). Either way the registered service name
 * stays `"vectorStore"` so swapping implementations is config-only.
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { InMemoryVectorStore } from "./in-memory-store";
import { PgVectorStore } from "./pgvector-store";
import { DEFAULT_VECTOR_DIMENSION } from "./schema";
import type { VectorStore } from "./types";

// ── Capability options ──────────────────────────────────────

export interface CapVectorPgvectorOptions {
  /**
   * Drizzle database instance for persistent storage. When omitted, the
   * capability falls back to {@link InMemoryVectorStore} — only suitable
   * for tests or dev environments without pgvector.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB type varies by driver
  db?: any;
  /**
   * Pre-built VectorStore instance. When provided, `db` and `dimension`
   * are ignored. Useful for tests and for hosts that wire a custom
   * implementation (e.g. `cap-vector-qdrant` adapter).
   */
  store?: VectorStore;
  /**
   * Vector dimension. Must match the column type emitted by the migration.
   * Defaults to {@link DEFAULT_VECTOR_DIMENSION}.
   */
  dimension?: number;
}

// ── Factory ──────────────────────────────────────────────────

/**
 * Create a fully-wired cap-vector-pgvector capability.
 *
 * @example
 * ```ts
 * import { createCapVectorPgvector } from "@linchkit/cap-vector-pgvector";
 *
 * const capVector = createCapVectorPgvector({ db });
 * // capVector.vectorStore is available immediately for capability setup;
 * // downstream capabilities resolve it via services["vectorStore"].
 * ```
 */
export function createCapVectorPgvector(
  options: CapVectorPgvectorOptions = {},
): CapabilityDefinition & { vectorStore: VectorStore } {
  const dimension = options.dimension ?? DEFAULT_VECTOR_DIMENSION;
  const store: VectorStore =
    options.store ??
    (options.db
      ? new PgVectorStore({ db: options.db, dimension })
      : new InMemoryVectorStore({ dimension }));

  const capability = defineCapability({
    name: "cap-vector-pgvector",
    label: "Vector Store (pgvector)",
    description:
      "PostgreSQL pgvector implementation of the VectorStore contract. " +
      "Backs Spec 55 evolution, Spec 67 Meta-Model semantics, Spec 53 Chatter RAG, " +
      "and Spec 52 AI few-shot example retrieval. Falls back to an in-memory " +
      "brute-force store when no Drizzle DB instance is supplied (dev / test only).",
    type: "standard",
    category: "system",
    version: "0.0.1",
    group: "vector",
    autoInstall: false,
    extensions: {
      services: [
        {
          name: "vectorStore",
          factory: () => store,
        },
      ],
    },
  });

  return Object.assign(capability, { vectorStore: store });
}

/** Static (in-memory) capability export for shape-only consumers. */
export const capVectorPgvector = createCapVectorPgvector;
