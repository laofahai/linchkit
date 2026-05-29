import { describe, expect, it } from "bun:test";
import {
  capabilityMetadataSchema,
  validateCapabilityMetadata,
} from "../src/types/capability-metadata";

// ── Fixtures ────────────────────────────────────────

const validMinimal = {
  name: "@linchkit/cap-auth",
  version: "1.0.0",
  type: "standard",
  category: "system",
  label: "Authentication",
};

const validFull = {
  name: "@linchkit/cap-adapter-mcp",
  version: "0.2.1",
  type: "adapter",
  category: "integration",
  label: "MCP Transport Adapter",
  description: "Model Context Protocol transport for LinchKit",
  dependencies: ["@linchkit/cap-auth"],
  extensions: {
    entities: ["mcp_connections"],
    actions: ["mcp:connect", "mcp:disconnect"],
    transports: ["mcp"],
    services: ["mcp-client"],
    commands: ["mcp:serve"],
  },
  author: "LinchKit Team",
  license: "MIT",
  repository: "https://github.com/linchkit/cap-adapter-mcp",
  main: "src/index.ts",
  ui: "ui/index.ts",
  linchkit: {
    minVersion: "0.1.0",
  },
};

// ── Schema validation ───────────────────────────────

describe("capabilityMetadataSchema", () => {
  it("accepts valid minimal metadata", () => {
    const result = capabilityMetadataSchema.safeParse(validMinimal);
    expect(result.success).toBe(true);
  });

  it("accepts valid full metadata", () => {
    const result = capabilityMetadataSchema.safeParse(validFull);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extensions?.transports).toEqual(["mcp"]);
      expect(result.data.extensions?.entities).toEqual(["mcp_connections"]);
      expect(result.data.extensions?.actions).toEqual(["mcp:connect", "mcp:disconnect"]);
      expect(result.data.linchkit?.minVersion).toBe("0.1.0");
      expect(result.data.author).toBe("LinchKit Team");
      expect(result.data.license).toBe("MIT");
      expect(result.data.repository).toBe("https://github.com/linchkit/cap-adapter-mcp");
      expect(result.data.main).toBe("src/index.ts");
      expect(result.data.ui).toBe("ui/index.ts");
    }
  });

  it("rejects missing required field: name", () => {
    const { name: _, ...rest } = validMinimal;
    const result = capabilityMetadataSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: version", () => {
    const { version: _, ...rest } = validMinimal;
    const result = capabilityMetadataSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: type", () => {
    const { type: _, ...rest } = validMinimal;
    const result = capabilityMetadataSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: category", () => {
    const { category: _, ...rest } = validMinimal;
    const result = capabilityMetadataSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: label", () => {
    const { label: _, ...rest } = validMinimal;
    const result = capabilityMetadataSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects invalid type value", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      type: "plugin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid category value", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      category: "unknown-category",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      name: "",
    });
    expect(result.success).toBe(false);
  });

  it("allows optional fields to be omitted", () => {
    // validMinimal omits description, dependencies, extensions, linchkit
    const result = capabilityMetadataSchema.safeParse(validMinimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBeUndefined();
      expect(result.data.dependencies).toBeUndefined();
      expect(result.data.extensions).toBeUndefined();
      expect(result.data.linchkit).toBeUndefined();
    }
  });

  it("accepts all valid type values", () => {
    for (const t of ["standard", "adapter", "bridge"]) {
      const result = capabilityMetadataSchema.safeParse({
        ...validMinimal,
        type: t,
      });
      expect(result.success).toBe(true);
    }
  });

  it("defaults main to 'src/index.ts' when omitted", () => {
    const result = capabilityMetadataSchema.safeParse(validMinimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.main).toBe("src/index.ts");
    }
  });

  it("rejects invalid repository URL", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      repository: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid repository URL", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      repository: "https://github.com/linchkit/cap-auth",
    });
    expect(result.success).toBe(true);
  });

  it("accepts extensions with schemas and actions", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      extensions: {
        entities: ["users", "sessions"],
        actions: ["auth:login", "auth:logout"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extensions?.entities).toEqual(["users", "sessions"]);
      expect(result.data.extensions?.actions).toEqual(["auth:login", "auth:logout"]);
    }
  });

  it("accepts linchkit.coreVersion semver range", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      linchkit: { coreVersion: ">=0.2.0 <0.4.0" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.linchkit?.coreVersion).toBe(">=0.2.0 <0.4.0");
    }
  });

  it("still accepts legacy linchkit.minVersion", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      linchkit: { minVersion: "0.1.0" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.linchkit?.minVersion).toBe("0.1.0");
    }
  });

  it("accepts both coreVersion and legacy minVersion together", () => {
    const result = capabilityMetadataSchema.safeParse({
      ...validMinimal,
      linchkit: { coreVersion: "^0.2.0", minVersion: "0.1.0" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.linchkit?.coreVersion).toBe("^0.2.0");
      expect(result.data.linchkit?.minVersion).toBe("0.1.0");
    }
  });

  it("accepts all valid category values", () => {
    for (const c of [
      "system",
      "infrastructure",
      "integration",
      "business",
      "ui",
      "utility",
      "starter",
    ]) {
      const result = capabilityMetadataSchema.safeParse({
        ...validMinimal,
        category: c,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ── validateCapabilityMetadata helper ───────────────

describe("validateCapabilityMetadata", () => {
  it("returns success with typed data for valid input", () => {
    const result = validateCapabilityMetadata(validFull);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("@linchkit/cap-adapter-mcp");
      expect(result.data.type).toBe("adapter");
    }
  });

  it("returns errors array for invalid input", () => {
    const result = validateCapabilityMetadata({ name: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("returns errors for completely empty input", () => {
    const result = validateCapabilityMetadata({});
    expect(result.success).toBe(false);
    if (!result.success) {
      // Should have errors for name, version, type, category, label
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    }
  });
});
