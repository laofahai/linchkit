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
});
