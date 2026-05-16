/**
 * Tests for `useShortcut` — the React hook that registers / unregisters
 * a shortcut against the surrounding registry.
 *
 * Bun's default test runner has no DOM. Following the same pattern as
 * cap-search-ui/useSearchClient.test.ts, we mock React's hook surface in
 * this file. Because `mock.module("react", ...)` leaks across files in
 * bun's shared test process, this file is the SINGLE place in
 * cap-keyboard-shortcuts that imports the hook — every other test stays
 * away from React so the mock cannot pollute them.
 *
 * What we verify:
 *   - calling the hook registers a shortcut on the provided registry
 *   - the cleanup function returned from the registration effect
 *     unregisters the shortcut (i.e. it cleans up on unmount)
 *   - the `when` predicate is read live so the dispatcher honors the
 *     latest predicate value, not a stale capture
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

// Capture the effects React would run so we can drive them manually.
// Effects either return nothing (void) or a cleanup callback — we wrap
// the cleanup branch in parens so biome's noConfusingVoidType rule stays
// happy without losing the "no cleanup" case.
type EffectCleanup = () => void;
type EffectFn = () => EffectCleanup | undefined;
const queuedEffects: EffectFn[] = [];
const refStore: Array<{ current: unknown }> = [];
let refCursor = 0;

let registryForContext: unknown = null;

beforeAll(() => {
  mock.module("react", () => ({
    useRef<T>(initial: T) {
      const slot = refStore[refCursor];
      if (slot) {
        refCursor++;
        return slot as { current: T };
      }
      const ref = { current: initial };
      refStore.push(ref);
      refCursor++;
      return ref as { current: T };
    },
    useEffect(fn: EffectFn) {
      queuedEffects.push(fn);
    },
    useContext() {
      return registryForContext;
    },
    // Stub the rest so importing the hook module never throws even if
    // future edits add more React calls.
    useState<T>(initial: T) {
      return [initial, () => {}] as const;
    },
    useMemo<T>(factory: () => T) {
      return factory();
    },
    useCallback<T>(fn: T) {
      return fn;
    },
    createContext() {
      return { Provider: () => null, Consumer: () => null };
    },
  }));
});

afterAll(() => {
  // Reset bookkeeping — module mocks are process-wide in bun:test.
  queuedEffects.length = 0;
  refStore.length = 0;
  refCursor = 0;
  registryForContext = null;
});

// Import AFTER the React mock is installed so the hook resolves against it.
const { useShortcut } = await import("../src/use-shortcut");
const { ShortcutRegistry } = await import("../src/shortcut-registry");

function runQueuedEffects(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  // Snapshot + clear so freshly-queued effects from nested hooks don't loop.
  const pending = queuedEffects.splice(0, queuedEffects.length);
  for (const fn of pending) {
    const result = fn();
    if (typeof result === "function") cleanups.push(result);
  }
  return cleanups;
}

function resetHookState(registry: unknown) {
  refStore.length = 0;
  refCursor = 0;
  queuedEffects.length = 0;
  registryForContext = registry;
}

describe("useShortcut", () => {
  it("registers a shortcut on the registry while mounted", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    resetHookState(registry);

    useShortcut({
      keys: "Mod+K",
      description: "Open search",
      handler: () => {},
    });

    runQueuedEffects();
    expect(registry.size()).toBe(1);
  });

  it("unregisters the shortcut when the cleanup function runs (unmount)", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    resetHookState(registry);

    useShortcut({
      keys: "Mod+S",
      description: "Save",
      handler: () => {},
    });

    const cleanups = runQueuedEffects();
    expect(registry.size()).toBe(1);

    for (const cleanup of cleanups) cleanup();
    expect(registry.size()).toBe(0);
  });

  it("honors the latest when() predicate during dispatch", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    resetHookState(registry);

    let allowed = false;
    let fired = 0;
    useShortcut({
      keys: "Mod+K",
      description: "Conditional",
      when: () => allowed,
      handler: () => {
        fired++;
      },
    });

    runQueuedEffects();

    const event = {
      key: "k",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    };

    expect(registry.dispatch({ event })).toBe(false);
    expect(fired).toBe(0);

    allowed = true;
    expect(registry.dispatch({ event })).toBe(true);
    expect(fired).toBe(1);
  });

  it("no-ops when keys is null (conditional registration)", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    resetHookState(registry);

    useShortcut({
      keys: null,
      description: "Disabled trigger",
      handler: () => {},
    });

    runQueuedEffects();
    expect(registry.size()).toBe(0);
  });

  it("no-ops when keys is undefined (conditional registration)", () => {
    const registry = new ShortcutRegistry({ platform: "other" });
    resetHookState(registry);

    useShortcut({
      description: "Disabled trigger",
      handler: () => {},
    });

    runQueuedEffects();
    expect(registry.size()).toBe(0);
  });
});
