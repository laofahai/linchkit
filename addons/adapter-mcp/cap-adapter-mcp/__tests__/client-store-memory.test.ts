/**
 * InMemoryMcpClientStore tests
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryMcpClientStore } from "../src/client-store-memory";
import type { McpClient } from "../src/types";

function makeClient(overrides: Partial<McpClient> = {}): McpClient {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    name: "Test Client",
    clientId: "test-client-1",
    secretHash: "hashed-secret",
    actorType: "ai",
    actorId: "actor-1",
    actorName: "Test Actor",
    actorGroups: ["ai_agent"],
    toolPolicy: { mode: "allow_all", tools: [] },
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("InMemoryMcpClientStore", () => {
  let store: InMemoryMcpClientStore;

  beforeEach(() => {
    store = new InMemoryMcpClientStore();
  });

  describe("create + findById", () => {
    it("stores and retrieves a client by id", async () => {
      const client = makeClient();
      await store.create(client);

      const found = await store.findById(client.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Test Client");
      expect(found!.clientId).toBe("test-client-1");
    });

    it("returns null for unknown id", async () => {
      const found = await store.findById("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("findByClientId", () => {
    it("finds a client by its public clientId", async () => {
      const client = makeClient({ clientId: "claude-desktop-prod" });
      await store.create(client);

      const found = await store.findByClientId("claude-desktop-prod");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(client.id);
    });

    it("returns null for unknown clientId", async () => {
      const found = await store.findByClientId("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all clients", async () => {
      await store.create(makeClient({ id: "a", clientId: "c1" }));
      await store.create(makeClient({ id: "b", clientId: "c2" }));

      const all = await store.list();
      expect(all).toHaveLength(2);
    });

    it("filters by enabled status", async () => {
      await store.create(makeClient({ id: "a", clientId: "c1", enabled: true }));
      await store.create(makeClient({ id: "b", clientId: "c2", enabled: false }));

      const enabled = await store.list({ enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe("a");

      const disabled = await store.list({ enabled: false });
      expect(disabled).toHaveLength(1);
      expect(disabled[0].id).toBe("b");
    });
  });

  describe("update", () => {
    it("updates client fields", async () => {
      const client = makeClient();
      await store.create(client);

      await store.update(client.id, { name: "Updated Name" });
      const found = await store.findById(client.id);
      expect(found!.name).toBe("Updated Name");
    });

    it("throws for unknown id", async () => {
      await expect(store.update("nonexistent", { name: "x" })).rejects.toThrow(
        "MCP client not found",
      );
    });
  });

  describe("delete", () => {
    it("removes a client", async () => {
      const client = makeClient();
      await store.create(client);

      await store.delete(client.id);
      const found = await store.findById(client.id);
      expect(found).toBeNull();
    });

    it("throws for unknown id", async () => {
      await expect(store.delete("nonexistent")).rejects.toThrow("MCP client not found");
    });
  });

  describe("touchLastUsed", () => {
    it("updates lastUsedAt timestamp", async () => {
      const client = makeClient();
      await store.create(client);

      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 5));
      await store.touchLastUsed(client.id);

      const found = await store.findById(client.id);
      expect(found!.lastUsedAt).toBeDefined();
      expect(found!.lastUsedAt!.getTime()).toBeGreaterThan(client.createdAt.getTime());
    });

    it("is a no-op for unknown id", async () => {
      // Should not throw
      await store.touchLastUsed("nonexistent");
    });
  });
});
