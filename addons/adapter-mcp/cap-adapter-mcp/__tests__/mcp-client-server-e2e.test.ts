/**
 * End-to-end MCP protocol round-trip test.
 *
 * Unlike the unit tests in `mcp-server.test.ts` (which reach into the server's
 * private `_registeredTools` map and invoke handlers directly with a mocked
 * CommandLayer), this test exercises the FULL stack over the real MCP wire
 * protocol:
 *
 *   real LinchKit capabilities (entity + action)
 *     -> real ActionExecutor + InMemory DataProvider (createTestRuntime)
 *     -> real CommandLayer (createCommandLayer)
 *     -> real McpServer (createMcpAdapter — same factory production uses)
 *     -> InMemoryTransport.createLinkedPair()  (the actual JSON-RPC pipe)
 *     -> real MCP Client (@modelcontextprotocol/sdk)
 *
 * The client speaks the protocol: initialize handshake, listTools, callTool,
 * listResources, readResource. Tool results come back through the real
 * CommandLayer pipeline and are persisted in the InMemory store — nothing here
 * is stubbed.
 *
 * SDK import paths verified against the installed @modelcontextprotocol/sdk
 * v1.29.0 (exports map + dist/esm/*.d.ts):
 *   - Client            : @modelcontextprotocol/sdk/client/index.js
 *   - InMemoryTransport : @modelcontextprotocol/sdk/inMemory.js
 *     (InMemoryTransport.createLinkedPair() returns a linked [client, server] pair)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineAction, defineEntity } from "@linchkit/core";
import { createCommandLayer } from "@linchkit/core/server";
import { createTestRuntime } from "@linchkit/devtools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpAdapter } from "../src/mcp-server";

// ── Real LinchKit capability under test ───────────────────────────────

const noteEntity = defineEntity({
  name: "note",
  label: "Note",
  description: "A simple note",
  fields: {
    title: { type: "string", label: "Title", required: true },
    body: { type: "text", label: "Body" },
  },
});

/**
 * Real action with an explicit handler that persists via `ctx.create`.
 * The handler runs inside the real executor, so the value the MCP client
 * receives is produced by the genuine pipeline and lands in the InMemory store.
 */
const createNoteAction = defineAction({
  name: "create_note",
  entity: "note",
  label: "Create Note",
  description: "Creates a new note",
  input: {
    title: { type: "string", required: true },
    body: { type: "text" },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    return ctx.create("note", {
      title: ctx.input.title,
      body: ctx.input.body ?? "",
    });
  },
});

// ── Shared real runtime + wired MCP client ────────────────────────────

let client: Client;
let runtime: ReturnType<typeof createTestRuntime>;

beforeAll(async () => {
  // Real executor + InMemory DataProvider + real registries.
  runtime = createTestRuntime({
    entities: [noteEntity],
    actions: [createNoteAction],
  });

  // Real CommandLayer wrapping the real executor — the same pipeline the
  // server/REST/GraphQL transports use. No mocking.
  const commandLayer = createCommandLayer({ executor: runtime.executor });

  // Build the MCP server exactly as production does.
  const { server } = await createMcpAdapter({
    commandLayer,
    entityRegistry: runtime.entityRegistry,
    actionRegistry: runtime.actionRegistry,
    name: "linchkit-e2e",
    version: "1.0.0",
  });

  // The actual MCP wire: a linked in-process JSON-RPC transport pair.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  client = new Client({ name: "e2e-test-client", version: "1.0.0" });

  // Connect both ends — this performs the real MCP initialize handshake.
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
});

describe("MCP client <-> server e2e (real protocol round-trip)", () => {
  test("handshake exposes the server identity", () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe("linchkit-e2e");
    expect(info?.version).toBe("1.0.0");
  });

  test("listTools returns the action tool derived from the real Action", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    // Action-derived tool.
    expect(names).toContain("create_note");
    // Built-in introspection tools wired by the real adapter.
    expect(names).toContain("list_entities");
    expect(names).toContain("get_entity");
    expect(names).toContain("list_actions");

    // The MCP adapter derives the tool description by prefixing the Action's
    // label: "<label>: <description>".
    const createNote = tools.find((t) => t.name === "create_note");
    expect(createNote?.description).toBe("Create Note: Creates a new note");
    expect(createNote?.inputSchema.type).toBe("object");
    expect(createNote?.inputSchema.properties).toHaveProperty("title");
    expect(createNote?.inputSchema.properties).toHaveProperty("body");
    expect(createNote?.inputSchema.required).toContain("title");
  });

  test("callTool executes through the real CommandLayer and persists", async () => {
    const result = await client.callTool({
      name: "create_note",
      arguments: { title: "Hello MCP", body: "round trip" },
    });

    // The MCP content is JSON-stringified ActionResult from the real pipeline.
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");

    const parsed = JSON.parse(content[0]?.text ?? "{}");
    expect(parsed.success).toBe(true);
    expect(parsed.data.title).toBe("Hello MCP");
    expect(parsed.data.body).toBe("round trip");
    // System fields are server-managed — proof the executor ran, not a stub.
    expect(parsed.data.id).toBeDefined();
    expect(parsed.executionId).toBeDefined();

    // The record really landed in the InMemory store via ctx.create.
    const persisted = await runtime.dataProvider.query("note", {});
    const created = persisted.find((r) => r.id === parsed.data.id);
    expect(created).toBeDefined();
    expect(created?.title).toBe("Hello MCP");
  });

  test("callTool surfaces the introspection result for list_entities", async () => {
    const result = await client.callTool({ name: "list_entities", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const entities = JSON.parse(content[0]?.text ?? "[]") as Array<{ name: string }>;

    expect(entities.some((e) => e.name === "note")).toBe(true);
  });

  test("listResources / readResource return real entity data", async () => {
    const { resources } = await client.listResources();
    const entitiesResource = resources.find((r) => r.uri === "linchkit://entities");
    expect(entitiesResource).toBeDefined();

    const read = await client.readResource({ uri: "linchkit://entities" });
    const contents = read.contents as Array<{ uri: string; text?: string; mimeType?: string }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]?.mimeType).toBe("application/json");

    const payload = JSON.parse(contents[0]?.text ?? "[]") as Array<{
      name: string;
      label?: string;
    }>;
    const note = payload.find((e) => e.name === "note");
    expect(note).toBeDefined();
    expect(note?.label).toBe("Note");
  });
});
