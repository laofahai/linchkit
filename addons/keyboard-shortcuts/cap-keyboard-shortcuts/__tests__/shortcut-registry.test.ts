/**
 * Tests for the ShortcutRegistry — registration lifecycle, conflict
 * detection, scope grouping, sequence dispatch, editable-target bail-out,
 * `when` predicate gating, modifier-only event filtering, and the
 * sequence-shadowing arbitration that defers single-key shortcuts when a
 * longer registered sequence shares the same prefix.
 */

import { describe, expect, it } from "bun:test";
import { MODIFIER_KEYS } from "../src/key-matcher";
import { type RegistryScheduler, ShortcutRegistry } from "../src/shortcut-registry";
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

/** Manual scheduler — tests advance time by invoking `flush()`. */
function createManualScheduler() {
  interface Pending {
    handle: number;
    fire: () => void;
  }
  const pending: Pending[] = [];
  let nextHandle = 1;
  const scheduler: RegistryScheduler = {
    setTimeout(fire) {
      const handle = nextHandle++;
      pending.push({ handle, fire });
      return handle;
    },
    clearTimeout(handle) {
      const idx = pending.findIndex((p) => p.handle === handle);
      if (idx >= 0) pending.splice(idx, 1);
    },
  };
  return {
    scheduler,
    flush(): number {
      const snapshot = pending.splice(0, pending.length);
      for (const item of snapshot) item.fire();
      return snapshot.length;
    },
    pendingCount(): number {
      return pending.length;
    },
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

describe("MODIFIER_KEYS export", () => {
  it("exposes a set the registry can consume to filter modifier-only events", () => {
    expect(MODIFIER_KEYS.has("shift")).toBe(true);
    expect(MODIFIER_KEYS.has("control")).toBe(true);
    expect(MODIFIER_KEYS.has("meta")).toBe(true);
    expect(MODIFIER_KEYS.has("alt")).toBe(true);
    // Non-modifier keys should not appear.
    expect(MODIFIER_KEYS.has("k")).toBe(false);
    expect(MODIFIER_KEYS.has("g")).toBe(false);
  });
});

describe("ShortcutRegistry modifier-only events", () => {
  it("does not let a bare Control press break a sequence", () => {
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
    // User taps Ctrl mid-sequence — must be ignored, NOT pushed to buffer.
    now += 50;
    const ctrlOnly = event({ key: "Control", ctrlKey: true });
    expect(registry.dispatch({ event: ctrlOnly, now })).toBe(false);
    now += 50;
    expect(registry.dispatch({ event: event({ key: "h" }), now })).toBe(true);
    expect(fired).toBe(1);
  });

  it("ignores Shift, Meta, Alt, and bare key-less events", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    let fired = 0;
    registry.register({
      keys: "Mod+K",
      description: "Open search",
      handler: () => {
        fired++;
      },
    });
    for (const key of ["Shift", "Meta", "Alt", "Control"]) {
      expect(
        registry.dispatch({
          event: event({ key, shiftKey: key === "Shift", metaKey: key === "Meta" }),
        }),
      ).toBe(false);
    }
    expect(registry.dispatch({ event: event({ key: "" }) })).toBe(false);
    expect(fired).toBe(0);
  });
});

describe("ShortcutRegistry sequence-shadowing arbitration", () => {
  it("defers single-key 'g' when a sequence 'g h' is also registered", () => {
    const { scheduler, pendingCount } = createManualScheduler();
    const registry = new ShortcutRegistry({
      platform: "other",
      sequencePrefixDelayMs: 200,
      scheduler,
    });
    let singleFired = 0;
    let sequenceFired = 0;
    registry.register({
      keys: "g",
      description: "Single g",
      handler: () => {
        singleFired++;
      },
    });
    registry.register({
      keys: "g h",
      description: "Go home",
      handler: () => {
        sequenceFired++;
      },
    });

    // Pressing "g" must NOT immediately fire the single — it's parked.
    let now = 1000;
    expect(registry.dispatch({ event: event({ key: "g" }), now })).toBe(false);
    expect(singleFired).toBe(0);
    expect(pendingCount()).toBe(1);

    // Pressing "h" within the window completes the sequence and cancels
    // the pending single-key dispatch.
    now += 50;
    expect(registry.dispatch({ event: event({ key: "h" }), now })).toBe(true);
    expect(sequenceFired).toBe(1);
    expect(singleFired).toBe(0);
    expect(pendingCount()).toBe(0);
  });

  it("fires single-key 'g' after the prefix-delay timeout when no follow-up arrives", () => {
    const { scheduler, flush } = createManualScheduler();
    const registry = new ShortcutRegistry({
      platform: "other",
      sequencePrefixDelayMs: 200,
      scheduler,
    });
    let singleFired = 0;
    let sequenceFired = 0;
    registry.register({
      keys: "g",
      description: "Single g",
      handler: () => {
        singleFired++;
      },
    });
    registry.register({
      keys: "g h",
      description: "Go home",
      handler: () => {
        sequenceFired++;
      },
    });

    expect(registry.dispatch({ event: event({ key: "g" }), now: 1000 })).toBe(false);
    expect(singleFired).toBe(0);

    // Simulate the prefix-delay timer firing.
    const fired = flush();
    expect(fired).toBe(1);
    expect(singleFired).toBe(1);
    expect(sequenceFired).toBe(0);
  });

  it("fires single-key immediately when no sequence prefix matches", () => {
    const { scheduler, pendingCount } = createManualScheduler();
    const registry = new ShortcutRegistry({
      platform: "other",
      sequencePrefixDelayMs: 200,
      scheduler,
    });
    let singleFired = 0;
    // "z" is unrelated to the "g h" sequence below, so it should fire now.
    registry.register({
      keys: "z",
      description: "Single z",
      handler: () => {
        singleFired++;
      },
    });
    registry.register({
      keys: "g h",
      description: "Go home",
      handler: () => {},
    });

    expect(registry.dispatch({ event: event({ key: "z" }) })).toBe(true);
    expect(singleFired).toBe(1);
    expect(pendingCount()).toBe(0);
  });

  it("cancels a deferred single-key dispatch if its target shortcut is unregistered", () => {
    const { scheduler, flush, pendingCount } = createManualScheduler();
    const registry = new ShortcutRegistry({
      platform: "other",
      sequencePrefixDelayMs: 200,
      scheduler,
    });
    let singleFired = 0;
    const singleId = registry.register({
      keys: "g",
      description: "Single g",
      handler: () => {
        singleFired++;
      },
    });
    registry.register({
      keys: "g h",
      description: "Go home",
      handler: () => {},
    });

    expect(registry.dispatch({ event: event({ key: "g" }), now: 1000 })).toBe(false);
    expect(pendingCount()).toBe(1);

    registry.unregister(singleId);
    expect(pendingCount()).toBe(0);
    flush();
    expect(singleFired).toBe(0);
  });
});
