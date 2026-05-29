import { describe, expect, test } from "bun:test";
import type { CapabilityDefinition } from "@linchkit/core";
import { resolveAutoInstall, resolveDependencies } from "../../src/capability/auto-install";

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

describe("resolveAutoInstall", () => {
  test("activates autoInstall cap when all deps are met", () => {
    const explicit = [cap("cap-chatter"), cap("cap-adapter-ui")];
    const discovered = [
      cap("cap-chatter-ui", {
        autoInstall: true,
        dependencies: ["cap-chatter", "cap-adapter-ui"],
      }),
    ];
    const result = resolveAutoInstall(explicit, discovered);
    expect(result.map((c) => c.name)).toContain("cap-chatter-ui");
  });

  test("does NOT activate when deps are missing", () => {
    const explicit = [cap("cap-chatter")];
    const discovered = [
      cap("cap-chatter-ui", {
        autoInstall: true,
        dependencies: ["cap-chatter", "cap-adapter-ui"],
      }),
    ];
    const result = resolveAutoInstall(explicit, discovered);
    expect(result.map((c) => c.name)).not.toContain("cap-chatter-ui");
  });

  test("handles transitive autoInstall chains", () => {
    const explicit = [cap("A"), cap("B")];
    const discovered = [
      cap("C", { autoInstall: true, dependencies: ["A", "B"] }),
      cap("D", { autoInstall: true, dependencies: ["C"] }),
    ];
    const result = resolveAutoInstall(explicit, discovered);
    const names = result.map((c) => c.name);
    expect(names).toContain("C");
    expect(names).toContain("D");
  });

  test("does NOT activate non-autoInstall caps", () => {
    const explicit = [cap("A")];
    const discovered = [cap("B", { autoInstall: false, dependencies: ["A"] })];
    const result = resolveAutoInstall(explicit, discovered);
    expect(result.map((c) => c.name)).not.toContain("B");
  });

  test("explicit caps are always included", () => {
    const explicit = [cap("A")];
    const result = resolveAutoInstall(explicit, []);
    expect(result.map((c) => c.name)).toEqual(["A"]);
  });

  test("skips already-explicit caps in discovered set", () => {
    const explicit = [cap("A")];
    const discovered = [cap("A", { autoInstall: true })];
    const result = resolveAutoInstall(explicit, discovered);
    const names = result.map((c) => c.name);
    expect(names.filter((n) => n === "A")).toHaveLength(1);
  });
});

describe("resolveDependencies", () => {
  test("pulls direct deps from available pool", () => {
    const explicit = [cap("cap-starter-minimal", { dependencies: ["cap-auth", "cap-permission"] })];
    const available = [cap("cap-auth"), cap("cap-permission")];
    const result = resolveDependencies(explicit, available);
    const names = result.map((c) => c.name);
    expect(names).toContain("cap-starter-minimal");
    expect(names).toContain("cap-auth");
    expect(names).toContain("cap-permission");
  });

  test("resolves transitive deps (A→B→C)", () => {
    const explicit = [cap("A", { dependencies: ["B"] })];
    const available = [cap("B", { dependencies: ["C"] }), cap("C")];
    const result = resolveDependencies(explicit, available);
    const names = result.map((c) => c.name);
    expect(names).toContain("A");
    expect(names).toContain("B");
    expect(names).toContain("C");
  });

  test("does not duplicate caps already in explicit", () => {
    const explicit = [cap("A"), cap("B", { dependencies: ["A"] })];
    const available = [cap("A"), cap("B", { dependencies: ["A"] })];
    const result = resolveDependencies(explicit, available);
    expect(result.map((c) => c.name).filter((n) => n === "A")).toHaveLength(1);
  });

  test("explicit caps satisfy each other's deps without adding duplicates", () => {
    const explicit = [cap("A", { dependencies: ["B"] }), cap("B")];
    const result = resolveDependencies(explicit, []);
    const names = result.map((c) => c.name);
    expect(names).toContain("A");
    expect(names).toContain("B");
    expect(names.filter((n) => n === "B")).toHaveLength(1);
  });

  test("handles circular deps without infinite loop", () => {
    const explicit = [cap("A", { dependencies: ["B"] })];
    const available = [cap("A", { dependencies: ["B"] }), cap("B", { dependencies: ["A"] })];
    expect(() => resolveDependencies(explicit, available)).not.toThrow();
    const names = resolveDependencies(explicit, available).map((c) => c.name);
    expect(names).toContain("A");
    expect(names).toContain("B");
  });

  test("silently skips missing deps (leaves for validation)", () => {
    const explicit = [cap("A", { dependencies: ["B", "C"] })];
    const available = [cap("B")]; // C is missing
    const result = resolveDependencies(explicit, available);
    const names = result.map((c) => c.name);
    expect(names).toContain("A");
    expect(names).toContain("B");
    expect(names).not.toContain("C");
  });

  test("returns explicit unchanged when no deps declared", () => {
    const explicit = [cap("A"), cap("B")];
    const result = resolveDependencies(explicit, []);
    expect(result.map((c) => c.name)).toEqual(["A", "B"]);
  });

  test("returns empty array for empty input", () => {
    expect(resolveDependencies([], [])).toHaveLength(0);
  });

  test("deduplicates duplicate names in explicit", () => {
    const result = resolveDependencies([cap("A"), cap("A")], []);
    expect(result.map((c) => c.name)).toEqual(["A"]);
  });

  test("explicit wins over available on name collision", () => {
    const explicitA = cap("A", { version: "2.0.0", dependencies: ["B"] });
    const availableA = cap("A", { version: "1.0.0" });
    const availableB = cap("B");
    const result = resolveDependencies([explicitA], [availableA, availableB]);
    const found = result.find((c) => c.name === "A");
    expect(found?.version).toBe("2.0.0");
  });

  test("integrates with resolveAutoInstall: pulled deps satisfy autoInstall conditions", () => {
    // starter explicitly lists a meta-pack; resolveDependencies pulls cap-auth + cap-permission;
    // resolveAutoInstall should then activate cap-auth-ui (autoInstall=true, dep on cap-auth)
    const explicit = [cap("cap-starter-minimal", { dependencies: ["cap-auth"] })];
    const available = [
      cap("cap-auth"),
      cap("cap-auth-ui", { autoInstall: true, dependencies: ["cap-auth"] }),
    ];
    const withDeps = resolveDependencies(explicit, available);
    const activeCaps = resolveAutoInstall(withDeps, available);
    const names = activeCaps.map((c) => c.name);
    expect(names).toContain("cap-auth");
    expect(names).toContain("cap-auth-ui");
  });
});
