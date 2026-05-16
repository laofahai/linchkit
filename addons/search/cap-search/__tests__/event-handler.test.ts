/**
 * Search indexer event-handler tests.
 *
 * Verifies that record.* events trigger the right upserts/deletes against an
 * in-memory store, and that entities without a registered defineSearchIndex
 * are ignored.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { EventRecord } from "@linchkit/core";
import { defineSearchIndex } from "../src/define-search-index";
import { buildSearchIndexRegistry, createSearchIndexer } from "../src/event-handler";
import { InMemorySearchService } from "../src/service";

const stubCtx = {
  emit: mock(() => {}),
  meta: { get: () => undefined, toJSON: () => ({}) },
};

function makeEvent(type: string, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "evt-001",
    type,
    category: "change",
    timestamp: new Date(),
    actor: { type: "user", id: "user-001" },
    executionId: "exec-001",
    payload: {},
    entity: "purchase_request",
    recordId: "rec-001",
    ...overrides,
  };
}

describe("createSearchIndexer", () => {
  let service: InMemorySearchService;

  const registry = buildSearchIndexRegistry([
    defineSearchIndex({
      entity: "purchase_request",
      fields: ["title", "description", "vendor"],
    }),
  ]);

  beforeEach(() => {
    service = new InMemorySearchService();
  });

  it("indexes record.created using the configured fields", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });
    await handler.handler(
      makeEvent("record.created", {
        payload: {
          _new: {
            title: "Office chairs",
            description: "Need 12 ergonomic chairs",
            vendor: "Acme",
            // unrelated field — should NOT be indexed
            _internal_secret: "do-not-leak",
          },
        },
      }),
      stubCtx as never,
    );

    const hits = await service.search("ergonomic");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.recordId).toBe("rec-001");

    const secretHits = await service.search("do-not-leak");
    expect(secretHits).toHaveLength(0);
  });

  it("supports the before/after payload convention", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });
    await handler.handler(
      makeEvent("record.updated", {
        payload: {
          before: { title: "Old", description: "x", vendor: "y" },
          after: { title: "New title", description: "Updated copy", vendor: "Beta" },
        },
      }),
      stubCtx as never,
    );

    const hits = await service.search("Updated");
    expect(hits).toHaveLength(1);
  });

  it("upsert on record.updated replaces the prior document", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });

    await handler.handler(
      makeEvent("record.created", {
        payload: { _new: { title: "First", description: "a", vendor: "v" } },
      }),
      stubCtx as never,
    );
    await handler.handler(
      makeEvent("record.updated", {
        payload: { _new: { title: "Second", description: "a", vendor: "v" } },
      }),
      stubCtx as never,
    );

    expect(service.size()).toBe(1);
    expect(await service.search("First")).toHaveLength(0);
    expect(await service.search("Second")).toHaveLength(1);
  });

  it("removes the document on record.deleted", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });
    await handler.handler(
      makeEvent("record.created", {
        payload: { _new: { title: "Doomed", description: "d", vendor: "v" } },
      }),
      stubCtx as never,
    );
    expect(service.size()).toBe(1);

    await handler.handler(makeEvent("record.deleted"), stubCtx as never);
    expect(service.size()).toBe(0);
  });

  it("ignores entities without a registered defineSearchIndex", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });
    await handler.handler(
      makeEvent("record.created", {
        entity: "unknown_entity",
        payload: { _new: { title: "Ignored" } },
      }),
      stubCtx as never,
    );
    expect(service.size()).toBe(0);
  });

  it("propagates tenantId to the store", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });
    await handler.handler(
      makeEvent("record.created", {
        tenantId: "tenant-A",
        payload: { _new: { title: "Tenant scoped", description: "x", vendor: "y" } },
      }),
      stubCtx as never,
    );

    const wrongTenantHits = await service.search("Tenant", { tenantId: "tenant-B" });
    expect(wrongTenantHits).toHaveLength(0);

    const rightTenantHits = await service.search("Tenant", { tenantId: "tenant-A" });
    expect(rightTenantHits).toHaveLength(1);
  });

  it("skips events without entity or recordId", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });
    await handler.handler(
      makeEvent("record.created", { entity: undefined, recordId: undefined }),
      stubCtx as never,
    );
    expect(service.size()).toBe(0);
  });

  it("buildSearchIndexRegistry rejects duplicate entity registrations", () => {
    const a = defineSearchIndex({ entity: "doc", fields: ["title"] });
    const b = defineSearchIndex({ entity: "doc", fields: ["body"] });
    expect(() => buildSearchIndexRegistry([a, b])).toThrow(/duplicate/);
  });

  it("defineSearchIndex rejects empty fields", () => {
    expect(() => defineSearchIndex({ entity: "doc", fields: [] })).toThrow();
    expect(() => defineSearchIndex({ entity: "", fields: ["x"] })).toThrow();
  });

  // Real CRUD payload shape from build-crud-actions.ts: the entity name is in
  // `payload.schema` (NOT `payload.entity`) and the new record is spread at
  // the top level of the payload (NOT under `_new`/`after`). The earlier
  // versions of these helpers silently dropped these events; codex flagged
  // it as P1 — these regression tests lock the contract.
  it("indexes a real CRUD record.created — schema + top-level fields", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });
    await handler.handler(
      makeEvent("record.created", {
        // Strip the `entity` overlay so we exercise the schema fallback.
        entity: undefined,
        payload: {
          schema: "purchase_request",
          recordId: "rec-001",
          // Spread record fields directly — matches build-crud-actions.ts:
          //   ctx.emit("record.created", { schema, recordId, ...result });
          title: "Office chairs",
          description: "Need 12 ergonomic chairs",
          vendor: "Acme",
          id: "rec-001",
        },
      }),
      stubCtx as never,
    );

    const hits = await service.search("ergonomic");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.recordId).toBe("rec-001");
  });

  it("indexes a real CRUD record.updated — _new under schema-keyed payload", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });
    await handler.handler(
      makeEvent("record.updated", {
        entity: undefined,
        payload: {
          schema: "purchase_request",
          recordId: "rec-001",
          _old: { title: "Old title" },
          _new: { title: "Brand-new chairs", description: "x", vendor: "Beta" },
          changedFields: ["title", "description", "vendor"],
        },
      }),
      stubCtx as never,
    );

    const hits = await service.search("Brand-new");
    expect(hits).toHaveLength(1);
  });

  it("removes the document on a real CRUD record.deleted", async () => {
    const handler = createSearchIndexer({ indexes: registry, service });

    // Seed via real-shape created event so we delete what was actually indexed.
    await handler.handler(
      makeEvent("record.created", {
        entity: undefined,
        payload: {
          schema: "purchase_request",
          recordId: "rec-001",
          title: "Doomed",
          description: "d",
          vendor: "v",
          id: "rec-001",
        },
      }),
      stubCtx as never,
    );
    expect(service.size()).toBe(1);

    await handler.handler(
      makeEvent("record.deleted", {
        entity: undefined,
        recordId: undefined,
        payload: { schema: "purchase_request", recordId: "rec-001", id: "rec-001" },
      }),
      stubCtx as never,
    );
    expect(service.size()).toBe(0);
  });
});
