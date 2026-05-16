/**
 * Tests for the ShortcutRegistry — registration lifecycle, conflict
 * detection, scope grouping, sequence dispatch, editable-target bail-out,
 * and `when` predicate gating.
 */

import { describe, expect, it } from "bun:test";
import { ShortcutRegistry } from "../src/shortcut-registry";
import type { KeyEventLike } from "../src/types";

function event(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("ShortcutRegistry.register / unregister", () => {
  it("registers and lists a shortcut with its scope", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    registry.register({
      keys: "Mod+K",
      description: "Open search",
      scope: "Search",
      handler: () => {},
    });
    const snapshots = registry.listShortcuts();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.scope).toBe("Search");
    expect(snapshots[0]?.enabled).toBe(true);
  });

  it("removes a shortcut on unregister", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    const id = registry.register({
      keys: "Mod+K",
      description: "Open search",
      handler: () => {},
    });
    expect(registry.size()).toBe(1);
    registry.unregister(id);
    expect(registry.size()).toBe(0);
  });

  it("defaults the scope to 'global'", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    registry.register({ keys: "Mod+K", description: "X", handler: () => {} });
    expect(registry.listShortcuts()[0]?.scope).toBe("global");
  });
});

describe("ShortcutRegistry conflict detection", () => {
  it("warns when two enabled handlers register the same keys in the same scope", () => {
    const messages: string[] = [];
    const registry = new ShortcutRegistry({
      platform: "other",
      warn: (msg) => messages.push(msg),
    });
    registry.register({ keys: "Mod+K", description: "A", scope: "Nav", handler: () => {} });
    registry.register({ keys: "Mod+K", description: "B", scope: "Nav", handler: () => {} });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("duplicate shortcut");
    expect(messages[0]).toContain("Nav");
  });

  it("does not warn when conflicting handlers live in different scopes", () => {
    const messages: string[] = [];
    const registry = new ShortcutRegistry({
      platform: "other",
      warn: (msg) => messages.push(msg),
    });
    registry.register({ keys: "Mod+K", description: "A", scope: "Nav", handler: () => {} });
    registry.register({ keys: "Mod+K", description: "B", scope: "Edit", handler: () => {} });
    expect(messages).toHaveLength(0);
  });

  it("treats modifier order as equivalent (Shift+Mod+K === Mod+Shift+K)", () => {
    const messages: string[] = [];
    const registry = new ShortcutRegistry({
      platform: "other",
      warn: (msg) => messages.push(msg),
    });
    registry.register({
      keys: "Shift+Mod+K",
      description: "A",
      scope: "Nav",
      handler: () => {},
    });
    registry.register({
      keys: "Mod+Shift+K",
      description: "B",
      scope: "Nav",
      handler: () => {},
    });
    expect(messages).toHaveLength(1);
  });

  it("ignores conflicts when the existing handler is disabled via when", () => {
    const messages: string[] = [];
    const registry = new ShortcutRegistry({
      platform: "other",
      warn: (msg) => messages.push(msg),
    });
    registry.register({
      keys: "Mod+K",
      description: "A",
      scope: "Nav",
      handler: () => {},
      when: () => false,
    });
    registry.register({ keys: "Mod+K", description: "B", scope: "Nav", handler: () => {} });
    expect(messages).toHaveLength(0);
  });
});

describe("ShortcutRegistry.dispatch", () => {
  it("invokes the matching handler and bails on editable target without allowInInput", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    let fired = 0;
    registry.register({
      keys: "Mod+K",
      description: "Open search",
      handler: () => {
        fired++;
      },
    });
    const handled = registry.dispatch({
      event: event({ key: "k", ctrlKey: true }),
      isEditableTarget: true,
    });
    expect(handled).toBe(false);
    expect(fired).toBe(0);
  });

  it("fires when allowInInput is set even inside editable elements", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    let fired = 0;
    registry.register({
      keys: "Mod+K",
      description: "Open search",
      allowInInput: true,
      handler: () => {
        fired++;
      },
    });
    const handled = registry.dispatch({
      event: event({ key: "k", ctrlKey: true }),
      isEditableTarget: true,
    });
    expect(handled).toBe(true);
    expect(fired).toBe(1);
  });

  it("matches a two-step sequence within the timeout window", () => {
    const registry = new ShortcutRegistry({
      platform: "other",
      sequenceTimeoutMs: 1000,
    });
    let fired = 0;
    registry.register({
      keys: "g h",
      description: "Go home",
      handler: () => {
        fired++;
      },
    });
    let now = 1000;
    expect(registry.dispatch({ event: event({ key: "g" }), now })).toBe(false);
    now += 500;
    expect(registry.dispatch({ event: event({ key: "h" }), now })).toBe(true);
    expect(fired).toBe(1);
  });

  it("does not match a sequence when the inter-key gap exceeds the timeout", () => {
    const registry = new ShortcutRegistry({
      platform: "other",
      sequenceTimeoutMs: 500,
    });
    let fired = 0;
    registry.register({
      keys: "g h",
      description: "Go home",
      handler: () => {
        fired++;
      },
    });
    let now = 1000;
    registry.dispatch({ event: event({ key: "g" }), now });
    now += 1000; // exceeds 500ms window
    expect(registry.dispatch({ event: event({ key: "h" }), now })).toBe(false);
    expect(fired).toBe(0);
  });

  it("skips shortcuts whose when() predicate currently returns false", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    let allowed = false;
    let fired = 0;
    registry.register({
      keys: "Mod+K",
      description: "X",
      when: () => allowed,
      handler: () => {
        fired++;
      },
    });
    expect(registry.dispatch({ event: event({ key: "k", ctrlKey: true }) })).toBe(false);
    allowed = true;
    expect(registry.dispatch({ event: event({ key: "k", ctrlKey: true }) })).toBe(true);
    expect(fired).toBe(1);
  });
});

describe("ShortcutRegistry.listShortcuts", () => {
  it("returns the enabled flag based on the when predicate", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    let allowed = false;
    registry.register({
      keys: "Mod+K",
      description: "X",
      when: () => allowed,
      handler: () => {},
    });
    expect(registry.listShortcuts()[0]?.enabled).toBe(false);
    allowed = true;
    expect(registry.listShortcuts()[0]?.enabled).toBe(true);
  });

  it("groups multiple shortcuts by scope in insertion order", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    registry.register({
      keys: "Mod+K",
      description: "Open search",
      scope: "Search",
      handler: () => {},
    });
    registry.register({
      keys: "Mod+S",
      description: "Save",
      scope: "Editor",
      handler: () => {},
    });
    registry.register({
      keys: "Mod+P",
      description: "Print",
      scope: "Editor",
      handler: () => {},
    });
    const snapshots = registry.listShortcuts();
    expect(snapshots.map((s) => s.scope)).toEqual(["Search", "Editor", "Editor"]);
  });
});
