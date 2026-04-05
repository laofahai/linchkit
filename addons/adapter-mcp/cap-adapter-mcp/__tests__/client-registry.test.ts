/**
 * McpClientRegistry tests
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { McpClientRegistry } from "../src/client-registry";
import { InMemoryMcpClientStore } from "../src/client-store-memory";
import type { ToolPolicy } from "../src/types";

describe("McpClientRegistry", () => {
  let store: InMemoryMcpClientStore;
  let registry: McpClientRegistry;

  beforeEach(() => {
    store = new InMemoryMcpClientStore();
    registry = new McpClientRegistry(store, { simpleBearerToken: "test-token-123" });
  });

  // ── createClient ─────────────────────────────────────────

  describe("createClient", () => {
    it("creates a client and returns a plaintext secret", async () => {
      const result = await registry.createClient({
        name: "Claude Desktop",
        clientId: "claude-desktop-prod",
      });

      expect(result.secret).toStartWith("mcp_");
      expect(result.client.name).toBe("Claude Desktop");
      expect(result.client.clientId).toBe("claude-desktop-prod");
      expect(result.client.enabled).toBe(true);
      expect(result.client.actorType).toBe("ai");
      expect(result.client.actorGroups).toEqual(["ai_agent"]);
    });

    it("stores a hashed secret, not plaintext", async () => {
      const result = await registry.createClient({
        name: "Test",
        clientId: "test-1",
      });

      // The stored hash should NOT equal the plaintext
      expect(result.client.secretHash).not.toBe(result.secret);
      // But it should verify
      const valid = await Bun.password.verify(result.secret, result.client.secretHash);
      expect(valid).toBe(true);
    });

    it("uses custom actor fields when provided", async () => {
      const result = await registry.createClient({
        name: "Service Bot",
        clientId: "svc-bot",
        actorType: "service",
        actorId: "custom-id",
        actorName: "Custom Name",
        actorGroups: ["admin", "service"],
      });

      expect(result.client.actorType).toBe("service");
      expect(result.client.actorId).toBe("custom-id");
      expect(result.client.actorName).toBe("Custom Name");
      expect(result.client.actorGroups).toEqual(["admin", "service"]);
    });
  });

  // ── resolveActor ─────────────────────────────────────────

  describe("resolveActor", () => {
    it("resolves actor from valid clientId:secret token", async () => {
      const { client, secret } = await registry.createClient({
        name: "My Client",
        clientId: "my-client",
        actorId: "actor-42",
        actorName: "My Actor",
        actorGroups: ["ai_agent", "reader"],
      });

      const token = `${client.clientId}:${secret}`;
      const result = await registry.resolveActor(token);

      expect(result).not.toBeNull();
      expect(result!.actor.id).toBe("actor-42");
      expect(result!.actor.name).toBe("My Actor");
      expect(result!.actor.type).toBe("ai");
      expect(result!.actor.groups).toEqual(["ai_agent", "reader"]);
      expect(result!.client.clientId).toBe("my-client");
    });

    it("returns null for invalid secret", async () => {
      const { client } = await registry.createClient({
        name: "Test",
        clientId: "test-client",
      });

      const actor = await registry.resolveActor(`${client.clientId}:wrong-secret`);
      expect(actor).toBeNull();
    });

    it("returns null for disabled client", async () => {
      const { client, secret } = await registry.createClient({
        name: "Test",
        clientId: "disabled-client",
      });

      await registry.toggleClient(client.id, false);

      const actor = await registry.resolveActor(`${client.clientId}:${secret}`);
      expect(actor).toBeNull();
    });

    it("returns null for expired client", async () => {
      const { client, secret } = await registry.createClient({
        name: "Test",
        clientId: "expired-client",
        expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
      });

      const actor = await registry.resolveActor(`${client.clientId}:${secret}`);
      expect(actor).toBeNull();
    });

    it("returns null for simple bearer token (handled by mcp-server fallback)", async () => {
      const result = await registry.resolveActor("test-token-123");
      expect(result).toBeNull();
    });

    it("returns null when simple bearer token does not match", async () => {
      const actor = await registry.resolveActor("wrong-token");
      expect(actor).toBeNull();
    });

    it("returns null for token without colon and no simple bearer", async () => {
      const registryNoFallback = new McpClientRegistry(store);
      const actor = await registryNoFallback.resolveActor("some-random-token");
      expect(actor).toBeNull();
    });
  });

  // ── rotateSecret ─────────────────────────────────────────

  describe("rotateSecret", () => {
    it("invalidates old secret and returns new one", async () => {
      const { client, secret: oldSecret } = await registry.createClient({
        name: "Rotate Test",
        clientId: "rotate-test",
      });

      const { secret: newSecret } = await registry.rotateSecret(client.id);

      // Old secret no longer works
      const actorOld = await registry.resolveActor(`${client.clientId}:${oldSecret}`);
      expect(actorOld).toBeNull();

      // New secret works
      const actorNew = await registry.resolveActor(`${client.clientId}:${newSecret}`);
      expect(actorNew).not.toBeNull();
    });

    it("throws for unknown client", async () => {
      await expect(registry.rotateSecret("nonexistent")).rejects.toThrow("MCP client not found");
    });
  });

  // ── toggleClient ─────────────────────────────────────────

  describe("toggleClient", () => {
    it("disables a client", async () => {
      const { client } = await registry.createClient({
        name: "Toggle Test",
        clientId: "toggle-test",
      });

      const updated = await registry.toggleClient(client.id, false);
      expect(updated.enabled).toBe(false);
    });

    it("re-enables a disabled client", async () => {
      const { client } = await registry.createClient({
        name: "Toggle Test",
        clientId: "toggle-test-2",
      });

      await registry.toggleClient(client.id, false);
      const updated = await registry.toggleClient(client.id, true);
      expect(updated.enabled).toBe(true);
    });
  });

  // ── updateClient / deleteClient / getClient / listClients ──

  describe("CRUD", () => {
    it("updates client fields", async () => {
      const { client } = await registry.createClient({
        name: "Original",
        clientId: "crud-test",
      });

      const updated = await registry.updateClient(client.id, {
        name: "Updated Name",
        actorGroups: ["admin"],
      });

      expect(updated.name).toBe("Updated Name");
      expect(updated.actorGroups).toEqual(["admin"]);
    });

    it("deletes a client", async () => {
      const { client } = await registry.createClient({
        name: "Delete Me",
        clientId: "delete-test",
      });

      await registry.deleteClient(client.id);
      const found = await registry.getClient(client.id);
      expect(found).toBeNull();
    });

    it("lists clients with filter", async () => {
      await registry.createClient({ name: "A", clientId: "a" });
      const { client: b } = await registry.createClient({ name: "B", clientId: "b" });
      await registry.toggleClient(b.id, false);

      const all = await registry.listClients();
      expect(all).toHaveLength(2);

      const enabled = await registry.listClients({ enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe("A");
    });
  });

  // ── filterTools ──────────────────────────────────────────

  describe("filterTools", () => {
    const tools = [
      { name: "list_entities" },
      { name: "describe_entity" },
      { name: "query" },
      { name: "execute_action" }, // category: actions (unmapped)
      { name: "scaffold_capability" },
      { name: "mcp_list_clients" },
      { name: "ontology_overview" },
    ];

    it("allow_all returns all tools", () => {
      const policy: ToolPolicy = { mode: "allow_all", tools: [] };
      const result = registry.filterTools(tools, policy);
      expect(result).toHaveLength(tools.length);
    });

    it("allowlist with explicit tool names", () => {
      const policy: ToolPolicy = { mode: "allowlist", tools: ["query", "list_entities"] };
      const result = registry.filterTools(tools, policy);
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.name)).toEqual(["list_entities", "query"]);
    });

    it("allowlist with categories", () => {
      const policy: ToolPolicy = {
        mode: "allowlist",
        tools: [],
        categories: { introspection: true, query: true },
      };
      const result = registry.filterTools(tools, policy);
      expect(result.map((t) => t.name)).toEqual(["list_entities", "describe_entity", "query"]);
    });

    it("denylist with explicit tool names", () => {
      const policy: ToolPolicy = { mode: "denylist", tools: ["mcp_list_clients"] };
      const result = registry.filterTools(tools, policy);
      expect(result).toHaveLength(tools.length - 1);
      expect(result.find((t) => t.name === "mcp_list_clients")).toBeUndefined();
    });

    it("denylist with categories", () => {
      const policy: ToolPolicy = {
        mode: "denylist",
        tools: [],
        categories: { management: false, scaffold: false },
      };
      const result = registry.filterTools(tools, policy);
      // Should exclude scaffold_capability and mcp_list_clients
      expect(result.find((t) => t.name === "scaffold_capability")).toBeUndefined();
      expect(result.find((t) => t.name === "mcp_list_clients")).toBeUndefined();
      expect(result).toHaveLength(5);
    });

    it("allowlist combines categories and explicit names", () => {
      const policy: ToolPolicy = {
        mode: "allowlist",
        tools: ["execute_action"],
        categories: { introspection: true },
      };
      const result = registry.filterTools(tools, policy);
      expect(result.map((t) => t.name)).toEqual([
        "list_entities",
        "describe_entity",
        "execute_action",
      ]);
    });
  });
});
