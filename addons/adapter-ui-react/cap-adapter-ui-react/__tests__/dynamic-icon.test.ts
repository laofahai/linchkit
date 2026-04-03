import { describe, expect, test } from "bun:test";
import { getLucideIcon } from "../src/lib/dynamic-icon";

describe("getLucideIcon", () => {
  test("returns a component for a valid icon name", () => {
    const Icon = getLucideIcon("ShoppingCart");
    expect(Icon).not.toBeNull();
    // lucide-react icons may be objects (forwardRef) rather than plain functions
    expect(Icon).toBeTruthy();
  });

  test("returns a component for another valid icon name", () => {
    const Icon = getLucideIcon("Check");
    expect(Icon).not.toBeNull();
  });

  test("returns null for an invalid icon name", () => {
    const Icon = getLucideIcon("NonExistentIconXYZ123");
    expect(Icon).toBeNull();
  });

  test("returns null for undefined", () => {
    const Icon = getLucideIcon(undefined);
    expect(Icon).toBeNull();
  });

  test("returns null for empty string", () => {
    // Empty string is falsy, so it returns null
    const Icon = getLucideIcon("");
    expect(Icon).toBeNull();
  });

  test("is case-sensitive — lowercase name returns null", () => {
    const Icon = getLucideIcon("shoppingcart");
    expect(Icon).toBeNull();
  });

  test("resolves common icons used in the project", () => {
    // Verify at least some well-known icons exist in the icons map
    // Use icons that are stable across lucide-react versions
    const Icon = getLucideIcon("Check");
    expect(Icon).not.toBeNull();
  });
});
