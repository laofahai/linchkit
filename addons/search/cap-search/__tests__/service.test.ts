/**
 * InMemorySearchService tests — verifies upsert/delete/search semantics
 * that the indexer relies on.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { InMemorySearchService } from "../src/service";

describe("InMemorySearchService", () => {
  let service: InMemorySearchService;

  beforeEach(() => {
    service = new InMemorySearchService();
  });

  it("indexes a document and finds it via case-insensitive substring match", async () => {
    await service.upsertDocument({
      entity: "purchase_request",
      recordId: "rec-1",
      content: "Ergonomic office chair for the design team",
    });

    const hits = await service.search("CHAIR");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entity).toBe("purchase_request");
    expect(hits[0]?.recordId).toBe("rec-1");
  });

  it("upsert replaces the previous document for the same (tenant, entity, recordId)", async () => {
    await service.upsertDocument({
      entity: "vendor",
      recordId: "v1",
      content: "Acme Industries",
    });
    await service.upsertDocument({
      entity: "vendor",
      recordId: "v1",
      content: "GlobalCo Trading",
    });

    expect(service.size()).toBe(1);
    expect(await service.search("Acme")).toHaveLength(0);
    expect(await service.search("GlobalCo")).toHaveLength(1);
  });

  it("scopes search results by tenantId", async () => {
    await service.upsertDocument({
      tenantId: "t1",
      entity: "doc",
      recordId: "a",
      content: "shared keyword",
    });
    await service.upsertDocument({
      tenantId: "t2",
      entity: "doc",
      recordId: "b",
      content: "shared keyword",
    });

    const t1Hits = await service.search("shared", { tenantId: "t1" });
    expect(t1Hits).toHaveLength(1);
    expect(t1Hits[0]?.recordId).toBe("a");

    const noTenantHits = await service.search("shared");
    // No tenant filter → matches the unscoped (undefined-tenant) bucket only,
    // which has zero docs in this test.
    expect(noTenantHits).toHaveLength(0);
  });

  it("filters by entity when provided", async () => {
    await service.upsertDocument({
      entity: "vendor",
      recordId: "v1",
      content: "office",
    });
    await service.upsertDocument({
      entity: "purchase_request",
      recordId: "p1",
      content: "office",
    });

    const onlyVendor = await service.search("office", { entity: "vendor" });
    expect(onlyVendor).toHaveLength(1);
    expect(onlyVendor[0]?.entity).toBe("vendor");
  });

  it("respects the limit option", async () => {
    for (let i = 0; i < 5; i++) {
      await service.upsertDocument({
        entity: "doc",
        recordId: `r${i}`,
        content: "alpha beta gamma",
      });
    }
    const hits = await service.search("alpha", { limit: 2 });
    expect(hits).toHaveLength(2);
  });

  it("delete removes the document", async () => {
    await service.upsertDocument({
      entity: "doc",
      recordId: "r1",
      content: "deletable content",
    });
    await service.deleteDocument({ entity: "doc", recordId: "r1" });
    const hits = await service.search("deletable");
    expect(hits).toHaveLength(0);
  });

  it("returns empty result for blank query", async () => {
    await service.upsertDocument({
      entity: "doc",
      recordId: "r1",
      content: "anything",
    });
    expect(await service.search("")).toHaveLength(0);
    expect(await service.search("   ")).toHaveLength(0);
  });
});
