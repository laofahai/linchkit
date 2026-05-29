import { describe, expect, test } from "bun:test";
import { starterMinimal } from "../src/capability";

describe("starter-minimal capability", () => {
  test("has the expected definition name", () => {
    expect(starterMinimal.name).toBe("starter-minimal");
  });

  test("declares cap-auth and cap-permission as dependencies", () => {
    expect(starterMinimal.dependencies).toEqual(["cap-auth", "cap-permission"]);
  });

  test("exposes a version string", () => {
    expect(starterMinimal.version).toBe("0.1.0");
  });

  test("is a system standard capability", () => {
    expect(starterMinimal.type).toBe("standard");
    expect(starterMinimal.category).toBe("system");
  });
});
