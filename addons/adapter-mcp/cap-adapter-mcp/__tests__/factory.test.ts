import { describe, expect, test } from "bun:test";
import { createCapAdapterMcp } from "../src/factory";

describe("createCapAdapterMcp", () => {
  test("returns a valid CapabilityDefinition", () => {
    const cap = createCapAdapterMcp();

    expect(cap).toBeDefined();
    expect(cap.name).toBe("cap-adapter-mcp");
    expect(cap.label).toBe("MCP Server");
    expect(cap.version).toBe("0.0.1");
  });

  test("has correct type and category metadata", () => {
    const cap = createCapAdapterMcp();

    expect(cap.type).toBe("adapter");
    expect(cap.category).toBe("integration");
  });

  test("registers mcp transport in extensions", () => {
    const cap = createCapAdapterMcp();

    expect(cap.extensions).toBeDefined();
    expect(cap.extensions?.transports).toBeDefined();
    expect(cap.extensions?.transports).toHaveLength(1);

    const transport = cap.extensions?.transports?.[0];
    expect(transport?.name).toBe("mcp");
    expect(transport?.label).toBe("Model Context Protocol");
    expect(typeof transport?.factory).toBe("function");
  });

  test("registers CLI commands in extensions", () => {
    const cap = createCapAdapterMcp();

    expect(cap.extensions?.commands).toBeDefined();
    expect(cap.extensions?.commands).toHaveLength(1);
    expect(cap.extensions?.commands?.[0]?.name).toBe("start");
    expect(cap.extensions?.commands?.[0]?.namespace).toBe("mcp");
  });

  test("defaults to stdio transport", () => {
    const cap = createCapAdapterMcp();

    const transport = cap.extensions?.transports?.[0];
    expect(transport?.config?.transport?.default).toBe("stdio");
  });

  test("accepts custom options", () => {
    const cap = createCapAdapterMcp({
      transport: "sse",
      auth: { token: "test-token" },
      name: "my-mcp-server",
      version: "2.0.0",
    });

    expect(cap).toBeDefined();
    expect(cap.name).toBe("cap-adapter-mcp");
    // Transport factory is configured — we verify it's callable
    const transport = cap.extensions?.transports?.[0];
    expect(typeof transport?.factory).toBe("function");
  });

  test("transport config includes bearerToken as secret", () => {
    const cap = createCapAdapterMcp();

    const transport = cap.extensions?.transports?.[0];
    expect(transport?.config?.bearerToken).toBeDefined();
    expect(transport?.config?.bearerToken?.type).toBe("string");
    expect(transport?.config?.bearerToken?.secret).toBe(true);
  });

  test("declares network:outbound system permission", () => {
    const cap = createCapAdapterMcp();

    expect(cap.systemPermissions).toContain("network:outbound");
  });
});
