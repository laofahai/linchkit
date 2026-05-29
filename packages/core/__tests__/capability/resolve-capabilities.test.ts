import { describe, expect, test } from "bun:test";
import type { CapabilityDefinition } from "@linchkit/core";
import {
  mergeCapabilityPool,
  resolveCapabilities,
} from "../../src/capability/resolve-capabilities";

function cap(name: string, opts?: Partial<CapabilityDefinition>): CapabilityDefinition {
  return {
    name,
    label: name,
    type: "standard",
    category: "system",
    version: "0.1.0",
    ...opts,
  };
}

describe("mergeCapabilityPool", () => {
  test("explicit wins over discovered on name collision", () => {
    const explicit = [cap("cap-auth", { version: "2.0.0" })];
    const discovered = [cap("cap-auth", { version: "1.0.0" })];
    const pool = mergeCapabilityPool(explicit, discovered);
    expect(pool.filter((c) => c.name === "cap-auth")).toHaveLength(1);
    expect(pool.find((c) => c.name === "cap-auth")?.version).toBe("2.0.0");
  });

  test("dedups discovered duplicates, keeping the first occurrence", () => {
    const discovered = [
      cap("cap-auth", { version: "1.0.0" }),
      cap("cap-auth", { version: "1.1.0" }),
    ];
    const pool = mergeCapabilityPool([], discovered);
    expect(pool.filter((c) => c.name === "cap-auth")).toHaveLength(1);
    expect(pool.find((c) => c.name === "cap-auth")?.version).toBe("1.0.0");
  });

  test("preserves order: explicit first, then non-colliding discovered", () => {
    const explicit = [cap("starter-minimal"), cap("cap-auth", { version: "2.0.0" })];
    const discovered = [cap("cap-auth", { version: "1.0.0" }), cap("cap-permission")];
    const pool = mergeCapabilityPool(explicit, discovered);
    expect(pool.map((c) => c.name)).toEqual(["starter-minimal", "cap-auth", "cap-permission"]);
  });

  test("returns empty array for empty input", () => {
    expect(mergeCapabilityPool([], [])).toHaveLength(0);
  });

  test("throws a clear error for a null explicit entry", () => {
    const explicit = [cap("cap-auth"), null] as unknown as CapabilityDefinition[];
    expect(() => mergeCapabilityPool(explicit, [])).toThrow(
      /explicit capability at index 1 is null\/undefined/,
    );
  });

  test("throws a clear error for an undefined discovered entry", () => {
    const discovered = [undefined] as unknown as CapabilityDefinition[];
    expect(() => mergeCapabilityPool([], discovered)).toThrow(
      /discovered capability at index 0 is null\/undefined/,
    );
  });

  test("throws a clear error for an explicit entry missing a name", () => {
    const explicit = [{ label: "broken" }] as unknown as CapabilityDefinition[];
    expect(() => mergeCapabilityPool(explicit, [])).toThrow(
      /explicit capability at index 0 has no valid "name"/,
    );
  });

  test("throws a clear error for an empty-string name", () => {
    const explicit = [cap("cap-auth"), cap("   ")];
    expect(() => mergeCapabilityPool(explicit, [])).toThrow(
      /explicit capability at index 1 has no valid "name"/,
    );
  });

  test("throws a clear error for a non-string name", () => {
    const discovered = [{ name: 42 }] as unknown as CapabilityDefinition[];
    expect(() => mergeCapabilityPool([], discovered)).toThrow(
      /discovered capability at index 0 has no valid "name"/,
    );
  });
});

describe("resolveCapabilities", () => {
  test("starter in explicit expands its deps from the discovered pool", () => {
    const explicit = [cap("starter-minimal", { dependencies: ["cap-auth", "cap-permission"] })];
    const discovered = [cap("cap-auth"), cap("cap-permission")];
    const active = resolveCapabilities(explicit, discovered).map((c) => c.name);
    expect(active).toContain("starter-minimal");
    expect(active).toContain("cap-auth");
    expect(active).toContain("cap-permission");
  });

  test("autoInstall companion lights up after deps are pulled in", () => {
    const explicit = [cap("starter-minimal", { dependencies: ["cap-auth"] })];
    const discovered = [
      cap("cap-auth"),
      cap("cap-auth-ui", { autoInstall: true, dependencies: ["cap-auth"] }),
    ];
    const active = resolveCapabilities(explicit, discovered).map((c) => c.name);
    expect(active).toContain("cap-auth");
    expect(active).toContain("cap-auth-ui");
  });

  test("missing deps are silently skipped (left for validation)", () => {
    const explicit = [cap("starter-minimal", { dependencies: ["cap-auth", "cap-permission"] })];
    const discovered = [cap("cap-auth")]; // cap-permission missing
    const active = resolveCapabilities(explicit, discovered).map((c) => c.name);
    expect(active).toContain("starter-minimal");
    expect(active).toContain("cap-auth");
    expect(active).not.toContain("cap-permission");
  });

  test("double-load yields one entry = the explicit (factory-wired) version", () => {
    // cap-auth appears both explicitly (wired) and as a bare scanned default
    const explicit = [cap("cap-auth", { version: "2.0.0" })];
    const discovered = [cap("cap-auth", { version: "1.0.0" })];
    const active = resolveCapabilities(explicit, discovered);
    const auth = active.filter((c) => c.name === "cap-auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]?.version).toBe("2.0.0");
  });

  test("explicit cap that itself satisfies a dep is not duplicated by discovery", () => {
    // cap-auth listed explicitly AND is a dep of the starter AND present in discovered
    const explicit = [
      cap("starter-minimal", { dependencies: ["cap-auth"] }),
      cap("cap-auth", { version: "2.0.0" }),
    ];
    const discovered = [cap("cap-auth", { version: "1.0.0" })];
    const active = resolveCapabilities(explicit, discovered);
    const auth = active.filter((c) => c.name === "cap-auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]?.version).toBe("2.0.0");
  });

  test("returns explicit unchanged when nothing to pull or auto-install", () => {
    const explicit = [cap("A"), cap("B")];
    const active = resolveCapabilities(explicit, []);
    expect(active.map((c) => c.name)).toEqual(["A", "B"]);
  });
});
