/**
 * Tests for the key-matcher parser + comparator.
 *
 * No DOM — we hand-craft `KeyEventLike` objects so the suite runs under
 * bun's default test runner. Platform is always passed explicitly so the
 * suite is deterministic regardless of where it executes.
 */

import { describe, expect, it } from "bun:test";
import { formatKeys, matchChord, parseChord, parseKeys } from "../src/key-matcher";
import type { KeyEventLike } from "../src/types";

function keyEvent(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("parseChord", () => {
  it("resolves Mod to Meta on mac", () => {
    const chord = parseChord("Mod+K", "mac");
    expect(chord).toEqual({ key: "k", meta: true, ctrl: false, alt: false, shift: false });
  });

  it("resolves Mod to Ctrl on non-mac platforms", () => {
    const chord = parseChord("Mod+K", "other");
    expect(chord).toEqual({ key: "k", meta: false, ctrl: true, alt: false, shift: false });
  });

  it("normalizes the Shift+/ chord", () => {
    const chord = parseChord("Shift+/", "other");
    expect(chord).toEqual({ key: "/", meta: false, ctrl: false, alt: false, shift: true });
  });

  it("rejects chords with no non-modifier key", () => {
    expect(() => parseChord("Shift+Ctrl", "other")).toThrow();
  });

  it("rejects chords with multiple non-modifier keys", () => {
    expect(() => parseChord("K+L", "other")).toThrow();
  });
});

describe("parseKeys", () => {
  it("parses a single-chord shortcut into one entry", () => {
    const chords = parseKeys("Mod+K", "mac");
    expect(chords).toHaveLength(1);
  });

  it("splits sequences on whitespace", () => {
    const chords = parseKeys("g h", "other");
    expect(chords).toHaveLength(2);
    expect(chords[0]?.key).toBe("g");
    expect(chords[1]?.key).toBe("h");
  });

  it("collapses multiple spaces between chord tokens", () => {
    const chords = parseKeys("g   h", "other");
    expect(chords).toHaveLength(2);
  });
});

describe("matchChord — Mod+K", () => {
  it("matches Meta+K on macOS", () => {
    const chord = parseChord("Mod+K", "mac");
    expect(matchChord(chord, keyEvent({ key: "k", metaKey: true }))).toBe(true);
  });

  it("does not match Ctrl+K on macOS (Mod resolved to Meta)", () => {
    const chord = parseChord("Mod+K", "mac");
    expect(matchChord(chord, keyEvent({ key: "k", ctrlKey: true }))).toBe(false);
  });

  it("matches Ctrl+K on non-mac platforms", () => {
    const chord = parseChord("Mod+K", "other");
    expect(matchChord(chord, keyEvent({ key: "k", ctrlKey: true }))).toBe(true);
  });

  it("does not match plain K (no modifier)", () => {
    const chord = parseChord("Mod+K", "other");
    expect(matchChord(chord, keyEvent({ key: "k" }))).toBe(false);
  });

  it("does not match Ctrl+Shift+K (extra modifier)", () => {
    const chord = parseChord("Mod+K", "other");
    expect(matchChord(chord, keyEvent({ key: "k", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("is case-insensitive on the event key", () => {
    const chord = parseChord("Mod+K", "other");
    expect(matchChord(chord, keyEvent({ key: "K", ctrlKey: true }))).toBe(true);
  });
});

describe("matchChord — Shift+/", () => {
  it("matches Shift+/ exactly", () => {
    const chord = parseChord("Shift+/", "other");
    expect(matchChord(chord, keyEvent({ key: "/", shiftKey: true }))).toBe(true);
  });

  it("does not match plain /", () => {
    const chord = parseChord("Shift+/", "other");
    expect(matchChord(chord, keyEvent({ key: "/" }))).toBe(false);
  });

  it("does not match unrelated keys", () => {
    const chord = parseChord("Shift+/", "other");
    expect(matchChord(chord, keyEvent({ key: "a", shiftKey: true }))).toBe(false);
  });
});

describe("matchChord — modifier-only events", () => {
  it("ignores a bare Shift keydown", () => {
    const chord = parseChord("Shift+/", "other");
    expect(matchChord(chord, keyEvent({ key: "Shift", shiftKey: true }))).toBe(false);
  });

  it("ignores a bare Control keydown", () => {
    const chord = parseChord("Mod+K", "other");
    expect(matchChord(chord, keyEvent({ key: "Control", ctrlKey: true }))).toBe(false);
  });

  it("ignores a bare Meta keydown", () => {
    const chord = parseChord("Mod+K", "mac");
    expect(matchChord(chord, keyEvent({ key: "Meta", metaKey: true }))).toBe(false);
  });
});

describe("formatKeys", () => {
  it("renders Mod+K with the platform glyph on mac", () => {
    expect(formatKeys("Mod+K", "mac")).toBe("⌘+K");
  });

  it("renders Mod+K with Ctrl on non-mac platforms", () => {
    expect(formatKeys("Mod+K", "other")).toBe("Ctrl+K");
  });

  it("joins sequence chords with a space", () => {
    expect(formatKeys("g h", "other")).toBe("G H");
  });
});
