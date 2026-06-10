import { describe, expect, test } from "bun:test";
import { capAdapterAgUi } from "../src/capability";
import { capAdapterAgUiConfig } from "../src/config";
import { createCapAdapterAgUi } from "../src/factory";

describe("cap-adapter-ag-ui capability", () => {
  test("static export is a valid CapabilityDefinition", () => {
    expect(capAdapterAgUi).toBeDefined();
    expect(capAdapterAgUi.name).toBe("cap-adapter-ag-ui");
    expect(capAdapterAgUi.label).toBe("AG-UI Server");
    expect(capAdapterAgUi.version).toBe("0.0.1");
  });

  test("has correct type and category metadata", () => {
    expect(capAdapterAgUi.type).toBe("adapter");
    expect(capAdapterAgUi.category).toBe("integration");
  });

  test("registers the agui transport in extensions", () => {
    expect(capAdapterAgUi.extensions).toBeDefined();
    expect(capAdapterAgUi.extensions?.transports).toHaveLength(1);

    const transport = capAdapterAgUi.extensions?.transports?.[0];
    expect(transport?.name).toBe("agui");
    expect(transport?.label).toBe("AG-UI (Agent-User Interaction)");
    expect(typeof transport?.factory).toBe("function");
  });

  test("declares network:outbound system permission", () => {
    expect(capAdapterAgUi.systemPermissions).toContain("network:outbound");
  });

  test("is opt-in (autoInstall: false)", () => {
    expect(capAdapterAgUi.autoInstall).toBe(false);
  });
});

describe("createCapAdapterAgUi", () => {
  test("returns a valid CapabilityDefinition", () => {
    const cap = createCapAdapterAgUi();

    expect(cap).toBeDefined();
    expect(cap.name).toBe("cap-adapter-ag-ui");
    expect(cap.type).toBe("adapter");
    expect(cap.category).toBe("integration");
  });

  test("registers the agui transport with a callable factory", () => {
    const cap = createCapAdapterAgUi();

    const transport = cap.extensions?.transports?.[0];
    expect(transport?.name).toBe("agui");
    expect(typeof transport?.factory).toBe("function");
  });
});

describe("capAdapterAgUiConfig", () => {
  test("parses defaults when given an empty object", () => {
    const parsed = capAdapterAgUiConfig.schema.parse({});

    expect(parsed.enabled).toBe(false);
    expect(parsed.basePath).toBe("/api/agui");
    expect(parsed.port).toBe(3003);
  });
});
