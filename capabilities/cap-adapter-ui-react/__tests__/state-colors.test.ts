import { describe, expect, test } from "bun:test";
import {
  resolveColorToken,
  getStateBadgeClass,
  getStateBarClass,
  resolveStateColor,
} from "../src/lib/state-colors";

describe("resolveColorToken", () => {
  test("returns 'default' when no color provided", () => {
    expect(resolveColorToken()).toBe("default");
    expect(resolveColorToken(undefined)).toBe("default");
  });

  test("returns exact token for known semantic colors", () => {
    expect(resolveColorToken("success")).toBe("success");
    expect(resolveColorToken("warning")).toBe("warning");
    expect(resolveColorToken("danger")).toBe("danger");
    expect(resolveColorToken("info")).toBe("info");
    expect(resolveColorToken("secondary")).toBe("secondary");
    expect(resolveColorToken("default")).toBe("default");
  });

  test("normalizes case", () => {
    expect(resolveColorToken("SUCCESS")).toBe("success");
    expect(resolveColorToken("Warning")).toBe("warning");
  });

  test("maps common color names to tokens", () => {
    expect(resolveColorToken("green")).toBe("success");
    expect(resolveColorToken("red")).toBe("danger");
    expect(resolveColorToken("yellow")).toBe("warning");
    expect(resolveColorToken("orange")).toBe("warning");
    expect(resolveColorToken("blue")).toBe("info");
    expect(resolveColorToken("gray")).toBe("secondary");
    expect(resolveColorToken("grey")).toBe("secondary");
  });

  test("falls back to 'default' for unknown colors", () => {
    expect(resolveColorToken("purple")).toBe("default");
    expect(resolveColorToken("magenta")).toBe("default");
  });
});

describe("getStateBadgeClass", () => {
  test("returns CSS class string for known tokens", () => {
    const cls = getStateBadgeClass("success");
    expect(cls).toContain("bg-green");
    expect(typeof cls).toBe("string");
  });

  test("returns default class for undefined", () => {
    const cls = getStateBadgeClass();
    expect(cls).toContain("bg-muted");
  });
});

describe("getStateBarClass", () => {
  test("returns CSS class string for known tokens", () => {
    const cls = getStateBarClass("danger");
    expect(cls).toContain("bg-red");
  });

  test("returns default class for undefined", () => {
    const cls = getStateBarClass();
    expect(cls).toContain("bg-primary");
  });
});

describe("resolveStateColor", () => {
  test("uses meta color when provided", () => {
    const meta = { approved: { label: "Approved", color: "green" } };
    expect(resolveStateColor("approved", meta)).toBe("success");
  });

  test("guesses color from common state names when no meta", () => {
    expect(resolveStateColor("approved")).toBe("success");
    expect(resolveStateColor("completed")).toBe("success");
    expect(resolveStateColor("pending")).toBe("warning");
    expect(resolveStateColor("rejected")).toBe("danger");
    expect(resolveStateColor("draft")).toBe("secondary");
  });

  test("returns default for unknown state names without meta", () => {
    expect(resolveStateColor("custom_state")).toBe("default");
  });
});
