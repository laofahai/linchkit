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
    transports: ["mcp"],
    services: ["mcp-client"],
    commands: ["mcp:serve"],
  },
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
      expect(result.data.linchkit?.minVersion).toBe("0.1.0");
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
