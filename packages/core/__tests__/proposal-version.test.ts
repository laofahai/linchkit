import { describe, expect, it } from "bun:test";
import { bumpVersion } from "../src/server-entry";

describe("bumpVersion", () => {
  it("bumps patch version", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("bumps minor version and resets patch", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  it("bumps major version and resets minor/patch", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("handles 0.0.0", () => {
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
    expect(bumpVersion("0.0.0", "minor")).toBe("0.1.0");
    expect(bumpVersion("0.0.0", "major")).toBe("1.0.0");
  });

  it("throws for invalid semver", () => {
    expect(() => bumpVersion("not.a.version", "patch")).toThrow("Invalid semver");
    expect(() => bumpVersion("1.2", "patch")).toThrow("Invalid semver");
  });
});
