import { describe, expect, test } from "bun:test";
import type { CapabilityDefinition } from "@linchkit/core";
import { resolveAutoInstall } from "../../src/capability/auto-install";

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
