import { beforeEach, describe, expect, test } from "bun:test";
import type { WidgetDefinition } from "@linchkit/core/types";
import { createWidgetRegistry } from "../src/lib/widget-registry";

function makeDisplay(name: string) {
  // Return a dummy component function (no DOM rendering needed)
  const Comp = () => null;
  Comp.displayName = name;
  // biome-ignore lint/suspicious/noExplicitAny: test mock component
  return Comp as any;
}

function makeInput(name: string) {
  const Comp = () => null;
  Comp.displayName = name;
  // biome-ignore lint/suspicious/noExplicitAny: test mock component
  return Comp as any;
}

describe("WidgetRegistry", () => {
  let registry: ReturnType<typeof createWidgetRegistry>;

  beforeEach(() => {
    registry = createWidgetRegistry();
  });

  describe("register and list", () => {
    test("starts empty", () => {
      expect(registry.list()).toEqual([]);
    });

    test("registers a widget definition", () => {
      const def: WidgetDefinition = {
        id: "text",
        fieldTypes: "string",
        modes: ["display", "input"],
        isDefault: true,
      };
      registry.register({ definition: def, display: makeDisplay("TextDisplay") });
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0]?.id).toBe("text");
    });
  });

  describe("getDisplay / getInput", () => {
    test("returns null for unregistered widget", () => {
      expect(registry.getDisplay("nonexistent")).toBeNull();
      expect(registry.getInput("nonexistent")).toBeNull();
    });

    test("returns registered components", () => {
      const display = makeDisplay("D");
      const input = makeInput("I");
      registry.register({
        definition: {
          id: "w1",
          fieldTypes: "string",
          modes: ["display", "input"],
          isDefault: true,
        },
        display,
        input,
      });
      expect(registry.getDisplay("w1")).toBe(display);
      expect(registry.getInput("w1")).toBe(input);
    });
  });

  describe("resolve", () => {
    test("resolves default widget for field type", () => {
      registry.register({
        definition: {
          id: "str-default",
          fieldTypes: "string",
          modes: ["display"],
          isDefault: true,
        },
        display: makeDisplay("D"),
      });
      const resolved = registry.resolve({ fieldType: "string", mode: "display" });
      expect(resolved).toBe("str-default");
    });

    test("returns null when no matching widget", () => {
      const resolved = registry.resolve({ fieldType: "json", mode: "display" });
      expect(resolved).toBeNull();
    });

    test("explicit override takes priority over default", () => {
      registry.register({
        definition: {
          id: "str-default",
          fieldTypes: "string",
          modes: ["display"],
          isDefault: true,
        },
        display: makeDisplay("D1"),
      });
      registry.register({
        definition: { id: "str-custom", fieldTypes: "string", modes: ["display"] },
        display: makeDisplay("D2"),
      });
      const resolved = registry.resolve({
        fieldType: "string",
        mode: "display",
        widgetOverride: "str-custom",
      });
      expect(resolved).toBe("str-custom");
    });

    test("format-based matching takes priority over default", () => {
      registry.register({
        definition: {
          id: "str-default",
          fieldTypes: "string",
          modes: ["display"],
          isDefault: true,
        },
        display: makeDisplay("D1"),
      });
      registry.register({
        definition: {
          id: "str-email",
          fieldTypes: "string",
          modes: ["display"],
          supportedFormats: ["email"],
        },
        display: makeDisplay("D2"),
      });
      const resolved = registry.resolve({
        fieldType: "string",
        mode: "display",
        format: "email",
      });
      expect(resolved).toBe("str-email");
    });

    test("explicit override beats format match", () => {
      registry.register({
        definition: {
          id: "str-email",
          fieldTypes: "string",
          modes: ["display"],
          supportedFormats: ["email"],
        },
        display: makeDisplay("D1"),
      });
      registry.register({
        definition: { id: "str-custom", fieldTypes: "string", modes: ["display"] },
        display: makeDisplay("D2"),
      });
      const resolved = registry.resolve({
        fieldType: "string",
        mode: "display",
        format: "email",
        widgetOverride: "str-custom",
      });
      expect(resolved).toBe("str-custom");
    });
  });

  describe("overrideDisplay / overrideInput", () => {
    test("overrides display component", () => {
      const original = makeDisplay("Original");
      const replacement = makeDisplay("Replacement");
      registry.register({
        definition: { id: "w1", fieldTypes: "string", modes: ["display"], isDefault: true },
        display: original,
      });
      expect(registry.getDisplay("w1")).toBe(original);
      registry.overrideDisplay("w1", replacement);
      expect(registry.getDisplay("w1")).toBe(replacement);
    });

    test("overrides input component", () => {
      const original = makeInput("Original");
      const replacement = makeInput("Replacement");
      registry.register({
        definition: { id: "w1", fieldTypes: "number", modes: ["input"], isDefault: true },
        input: original,
      });
      registry.overrideInput("w1", replacement);
      expect(registry.getInput("w1")).toBe(replacement);
    });

    test("no-op for unregistered widget", () => {
      // Should not throw
      registry.overrideDisplay("nonexistent", makeDisplay("X"));
      registry.overrideInput("nonexistent", makeInput("X"));
    });
  });

  describe("multiple field types", () => {
    test("registers as default for multiple field types", () => {
      registry.register({
        definition: {
          id: "multi",
          fieldTypes: ["string", "text"],
          modes: ["display"],
          isDefault: true,
        },
        display: makeDisplay("Multi"),
      });
      expect(registry.resolve({ fieldType: "string", mode: "display" })).toBe("multi");
      expect(registry.resolve({ fieldType: "text", mode: "display" })).toBe("multi");
    });
  });
});
