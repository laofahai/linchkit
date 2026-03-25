import { describe, expect, it } from "bun:test";
import {
  ConfigValidationError,
  RuntimeConfigRegistry,
} from "../src/config/runtime-config-registry";
import type { ConfigDefinition } from "../src/types/runtime-config";

const approvalConfig: ConfigDefinition = {
  name: "approval-settings",
  schema: "cap-approval",
  label: "Approval Settings",
  fields: {
    threshold: {
      type: "number",
      label: "Approval Threshold",
      required: true,
      default: 10000,
      validation: { min: 0, max: 1000000 },
    },
    requireDualSign: {
      type: "boolean",
      label: "Require Dual Signature",
      default: false,
    },
    webhookUrl: {
      type: "string",
      label: "Webhook URL",
      secret: true,
      validation: { pattern: "^https://" },
    },
    metadata: {
      type: "json",
      label: "Extra Metadata",
    },
  },
  defaults: {
    threshold: 10000,
    requireDualSign: false,
  },
};

describe("RuntimeConfigRegistry", () => {
  // ── Registration ──────────────────────────────────────

  describe("register", () => {
    it("registers a config definition", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(registry.get("approval-settings")).toBeDefined();
      expect(registry.get("approval-settings")?.name).toBe("approval-settings");
    });

    it("throws on duplicate registration", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() => registry.register(approvalConfig)).toThrow("already registered");
    });
  });

  // ── Listing ───────────────────────────────────────────

  describe("list / configsFor", () => {
    it("lists all registered configs", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      registry.register({
        name: "notification-settings",
        schema: "cap-notification",
        fields: { enabled: { type: "boolean", default: true } },
        defaults: { enabled: true },
      });
      expect(registry.list()).toHaveLength(2);
    });

    it("filters configs by schema", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      registry.register({
        name: "approval-advanced",
        schema: "cap-approval",
        fields: { maxRetries: { type: "number", default: 3 } },
        defaults: { maxRetries: 3 },
      });
      registry.register({
        name: "notification-settings",
        schema: "cap-notification",
        fields: { enabled: { type: "boolean", default: true } },
        defaults: { enabled: true },
      });

      const approvalConfigs = registry.configsFor("cap-approval");
      expect(approvalConfigs).toHaveLength(2);
      expect(approvalConfigs.map((c) => c.name)).toContain("approval-settings");
      expect(approvalConfigs.map((c) => c.name)).toContain("approval-advanced");
    });

    it("returns empty array for unknown schema", () => {
      const registry = new RuntimeConfigRegistry();
      expect(registry.configsFor("nonexistent")).toEqual([]);
    });
  });

  // ── Defaults ──────────────────────────────────────────

  describe("defaults", () => {
    it("initializes values from field-level defaults", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(registry.getValue("approval-settings", "threshold")).toBe(10000);
      expect(registry.getValue("approval-settings", "requireDualSign")).toBe(false);
    });

    it("field-level default takes precedence over top-level defaults", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register({
        name: "test-config",
        schema: "test",
        fields: {
          port: { type: "number", default: 8080 },
        },
        defaults: { port: 3000 }, // Should be overridden by field-level default
      });
      expect(registry.getValue("test-config", "port")).toBe(8080);
    });

    it("falls back to top-level defaults when no field-level default", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register({
        name: "test-config",
        schema: "test",
        fields: {
          port: { type: "number" }, // No field-level default
        },
        defaults: { port: 3000 },
      });
      expect(registry.getValue("test-config", "port")).toBe(3000);
    });

    it("returns undefined when no default exists", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(registry.getValue("approval-settings", "webhookUrl")).toBeUndefined();
    });
  });

  // ── getValue / getValues ──────────────────────────────

  describe("getValue / getValues", () => {
    it("throws for unregistered config name", () => {
      const registry = new RuntimeConfigRegistry();
      expect(() => registry.getValue("nonexistent", "foo")).toThrow("not registered");
    });

    it("throws for unknown field name", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() => registry.getValue("approval-settings", "nonexistent")).toThrow("no field");
    });

    it("getValues returns all fields as an object", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      const values = registry.getValues("approval-settings");
      expect(values).toEqual({
        threshold: 10000,
        requireDualSign: false,
        webhookUrl: undefined,
        metadata: undefined,
      });
    });
  });

  // ── setValue ───────────────────────────────────────────

  describe("setValue", () => {
    it("sets and retrieves a value", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);

      registry.setValue("approval-settings", "threshold", 50000);
      expect(registry.getValue("approval-settings", "threshold")).toBe(50000);
    });

    it("overrides the default", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(registry.getValue("approval-settings", "requireDualSign")).toBe(false);

      registry.setValue("approval-settings", "requireDualSign", true);
      expect(registry.getValue("approval-settings", "requireDualSign")).toBe(true);
    });

    it("throws for unregistered config name", () => {
      const registry = new RuntimeConfigRegistry();
      expect(() => registry.setValue("nonexistent", "foo", 1)).toThrow("not registered");
    });

    it("throws for unknown field name", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() => registry.setValue("approval-settings", "nonexistent", 1)).toThrow("no field");
    });
  });

  // ── Validation ────────────────────────────────────────

  describe("validation", () => {
    it("rejects wrong type (string instead of number)", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() => registry.setValue("approval-settings", "threshold", "abc")).toThrow(
        ConfigValidationError,
      );
    });

    it("rejects wrong type (number instead of boolean)", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() => registry.setValue("approval-settings", "requireDualSign", 42)).toThrow(
        ConfigValidationError,
      );
    });

    it("rejects number below min", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() => registry.setValue("approval-settings", "threshold", -1)).toThrow("must be >= 0");
    });

    it("rejects number above max", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() => registry.setValue("approval-settings", "threshold", 2000000)).toThrow(
        "must be <= 1000000",
      );
    });

    it("rejects string not matching pattern", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() =>
        registry.setValue("approval-settings", "webhookUrl", "http://insecure.example.com"),
      ).toThrow("must match pattern");
    });

    it("accepts string matching pattern", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      registry.setValue("approval-settings", "webhookUrl", "https://secure.example.com/hook");
      expect(registry.getValue("approval-settings", "webhookUrl")).toBe(
        "https://secure.example.com/hook",
      );
    });

    it("accepts any value for json type", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      const obj = { nested: { data: [1, 2, 3] } };
      registry.setValue("approval-settings", "metadata", obj);
      expect(registry.getValue("approval-settings", "metadata")).toEqual(obj);
    });

    it("rejects NaN for number type", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      expect(() => registry.setValue("approval-settings", "threshold", Number.NaN)).toThrow(
        ConfigValidationError,
      );
    });

    it("validates string length constraints", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register({
        name: "len-config",
        schema: "test",
        fields: {
          code: {
            type: "string",
            validation: { min: 2, max: 5 },
          },
        },
        defaults: {},
      });

      expect(() => registry.setValue("len-config", "code", "a")).toThrow("length must be >= 2");
      expect(() => registry.setValue("len-config", "code", "toolong")).toThrow(
        "length must be <= 5",
      );
      registry.setValue("len-config", "code", "ok");
      expect(registry.getValue("len-config", "code")).toBe("ok");
    });

    it("allows null/undefined for optional fields", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      // webhookUrl is optional (required is not set)
      registry.setValue("approval-settings", "webhookUrl", undefined);
      expect(registry.getValue("approval-settings", "webhookUrl")).toBeUndefined();
    });

    it("rejects null/undefined for required fields", () => {
      const registry = new RuntimeConfigRegistry();
      registry.register(approvalConfig);
      // threshold is required
      expect(() => registry.setValue("approval-settings", "threshold", undefined)).toThrow(
        "is required",
      );
    });
  });
});
