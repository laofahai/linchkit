import { afterEach, describe, expect, test } from "bun:test";
import type { ActionResult, CommandLayer } from "@linchkit/core";
import { defineAction, defineEntity } from "@linchkit/core";
import { ActionRegistry, createEntityRegistry } from "@linchkit/core/server";
import { createMcpAdapter } from "../src/mcp-server";
import { createMcpSseServer } from "../src/sse-transport";

const testSchema = defineEntity({
  name: "order",
  label: "Order",
  description: "Sales order",
  fields: {
    customer_name: { type: "string", label: "Customer", required: true },
    amount: { type: "number", label: "Amount", min: 0 },
  },
});

const testAction = defineAction({
  name: "create_order",
  schema: "order",
  label: "Create Order",
  description: "Creates a new sales order",
  input: {
    customer_name: { type: "string", required: true },
    amount: { type: "number", min: 0 },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
});

/** Create a mock CommandLayer */
function mockCommandLayer(): CommandLayer {
  return {
    execute: async () =>
      ({
        success: true,
        data: { id: "1" },
        executionId: "exec-1",
      }) as ActionResult,
    use: () => {},
  } as unknown as CommandLayer;
}

/** Helper to create a test MCP adapter */
async function createTestAdapter(bearerToken?: string) {
  const entityRegistry = createEntityRegistry();
  entityRegistry.register(testSchema);
  const actionRegistry = new ActionRegistry();
  actionRegistry.register(testAction);

  return createMcpAdapter({
    commandLayer: mockCommandLayer(),
    entityRegistry,
    actionRegistry,
    name: "test-mcp",
    version: "1.0.0",
    bearerToken,
  });
}

// Track servers to clean up
const servers: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers) {
    try {
      await s.stop();
    } catch {
      // ignore cleanup errors
    }
  }
  servers.length = 0;
});

describe("createMcpSseServer", () => {
  test("creates SSE server and starts on given port", async () => {
    const adapter = await createTestAdapter();
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter()).server,
      validateAuth: adapter.validateAuth,
      authEnabled: adapter.authEnabled,
      port: 13100,
    });
    servers.push(sseServer);

    expect(sseServer.httpServer).toBeDefined();
    expect(typeof sseServer.start).toBe("function");
    expect(typeof sseServer.stop).toBe("function");

    await sseServer.start();

    // Server should be listening — verify with a health-like request
    const res = await fetch("http://localhost:13100/nonexistent");
    expect(res.status).toBe(404);
  });

  test("GET /sse returns SSE stream (text/event-stream)", async () => {
    const adapter = await createTestAdapter();
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter()).server,
      validateAuth: adapter.validateAuth,
      authEnabled: false,
      port: 13101,
    });
    servers.push(sseServer);
    await sseServer.start();

    // Connect to SSE endpoint
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      const res = await fetch("http://localhost:13101/sse", {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      // Read the first chunk — should contain the endpoint event
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("event: endpoint");
      expect(text).toContain("/messages?sessionId=");

      reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  test("POST /messages without sessionId returns 400", async () => {
    const adapter = await createTestAdapter();
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter()).server,
      validateAuth: adapter.validateAuth,
      authEnabled: false,
      port: 13102,
    });
    servers.push(sseServer);
    await sseServer.start();

    const res = await fetch("http://localhost:13102/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("sessionId");
  });

  test("POST /messages with invalid sessionId returns 404", async () => {
    const adapter = await createTestAdapter();
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter()).server,
      validateAuth: adapter.validateAuth,
      authEnabled: false,
      port: 13103,
    });
    servers.push(sseServer);
    await sseServer.start();

    const res = await fetch("http://localhost:13103/messages?sessionId=nonexistent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("OPTIONS returns CORS headers", async () => {
    const adapter = await createTestAdapter();
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter()).server,
      validateAuth: adapter.validateAuth,
      authEnabled: false,
      port: 13104,
    });
    servers.push(sseServer);
    await sseServer.start();

    const res = await fetch("http://localhost:13104/sse", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});

describe("SSE transport bearer token auth", () => {
  test("returns 401 when auth enabled and no token provided", async () => {
    const adapter = await createTestAdapter("secret-token-123");
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter("secret-token-123")).server,
      validateAuth: adapter.validateAuth,
      authEnabled: adapter.authEnabled,
      port: 13110,
    });
    servers.push(sseServer);
    await sseServer.start();

    // GET /sse without token
    const sseRes = await fetch("http://localhost:13110/sse");
    expect(sseRes.status).toBe(401);

    // POST /messages without token
    const postRes = await fetch("http://localhost:13110/messages?sessionId=test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(postRes.status).toBe(401);
  });

  test("returns 401 when auth enabled and wrong token provided", async () => {
    const adapter = await createTestAdapter("secret-token-123");
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter("secret-token-123")).server,
      validateAuth: adapter.validateAuth,
      authEnabled: adapter.authEnabled,
      port: 13111,
    });
    servers.push(sseServer);
    await sseServer.start();

    const res = await fetch("http://localhost:13111/sse", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Unauthorized");
  });

  test("allows access with valid token", async () => {
    const adapter = await createTestAdapter("secret-token-123");
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter("secret-token-123")).server,
      validateAuth: adapter.validateAuth,
      authEnabled: adapter.authEnabled,
      port: 13112,
    });
    servers.push(sseServer);
    await sseServer.start();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      const res = await fetch("http://localhost:13112/sse", {
        signal: controller.signal,
        headers: { Authorization: "Bearer secret-token-123" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("event: endpoint");

      reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  test("no auth enforcement when auth is disabled (no token configured)", async () => {
    const adapter = await createTestAdapter(); // no token
    const sseServer = createMcpSseServer({
      createMcpServer: async () => (await createTestAdapter()).server,
      validateAuth: adapter.validateAuth,
      authEnabled: adapter.authEnabled,
      port: 13113,
    });
    servers.push(sseServer);
    await sseServer.start();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      // Should work without any Authorization header
      const res = await fetch("http://localhost:13113/sse", {
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });
});
