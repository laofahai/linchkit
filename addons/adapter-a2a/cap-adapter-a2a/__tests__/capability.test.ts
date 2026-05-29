import { describe, expect, test } from "bun:test";
import { capAdapterA2aConfig } from "../src/config";
import { createCapAdapterA2a } from "../src/factory";

describe("createCapAdapterA2a", () => {
  test("returns a valid CapabilityDefinition", () => {
    const cap = createCapAdapterA2a();

    expect(cap).toBeDefined();
    expect(cap.name).toBe("cap-adapter-a2a");
    expect(cap.label).toBe("A2A Server");
    expect(cap.version).toBe("0.0.1");
  });

  test("has correct type and category metadata", () => {
    const cap = createCapAdapterA2a();

    expect(cap.type).toBe("adapter");
    expect(cap.category).toBe("integration");
  });

  test("registers the a2a transport in extensions", () => {
    const cap = createCapAdapterA2a();

    expect(cap.extensions).toBeDefined();
    expect(cap.extensions?.transports).toBeDefined();
    expect(cap.extensions?.transports).toHaveLength(1);

    const transport = cap.extensions?.transports?.[0];
    expect(transport?.name).toBe("a2a");
    expect(transport?.label).toBe("Agent-to-Agent Protocol");
    expect(typeof transport?.factory).toBe("function");
  });

  test("declares network:outbound system permission", () => {
    const cap = createCapAdapterA2a();

    expect(cap.systemPermissions).toContain("network:outbound");
  });

  test("accepts declarative config options", () => {
    const cap = createCapAdapterA2a({ config: { enabled: true, port: 4444 } });

    expect(cap).toBeDefined();
    expect(cap.name).toBe("cap-adapter-a2a");
    const transport = cap.extensions?.transports?.[0];
    expect(typeof transport?.factory).toBe("function");
  });
});

describe("capAdapterA2aConfig", () => {
  test("parses its defaults", () => {
    const parsed = capAdapterA2aConfig.schema.parse({});

    expect(parsed.enabled).toBe(false);
    expect(parsed.port).toBe(3003);
    expect(parsed.basePath).toBe("/a2a");
  });

  test("is bound to the cap-adapter-a2a namespace", () => {
    expect(capAdapterA2aConfig.name).toBe("cap-adapter-a2a");
  });
});
