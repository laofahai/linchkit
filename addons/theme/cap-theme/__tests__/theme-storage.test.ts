/**
 * Tests for the localStorage persistence helpers.
 *
 * The helpers run in both browser and SSR contexts so we exercise:
 *   - Happy-path round-trip (write → read returns same value)
 *   - Missing key → `undefined`
 *   - Malformed / wrong-shape JSON → `undefined` (never throws)
 *   - Storage that throws on access (Safari private mode, sandboxed iframes)
 *
 * We stub `window.localStorage` on the global per test instead of relying on
 * jsdom — the helpers only touch the three Storage methods (`getItem`,
 * `setItem`, `removeItem`) plus the `window` global itself, so a minimal
 * fake is enough and keeps the test logic-only.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearStoredTheme,
  readStoredTheme,
  writeStoredTheme,
} from "../src/theme-storage";
import { THEME_STORAGE_KEY } from "../src/types";

interface FakeStorage extends Storage {
  store: Map<string, string>;
}

function makeStorage(): FakeStorage {
  const store = new Map<string, string>();
  const storage: FakeStorage = {
    store,
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return storage;
}

/**
 * Install a fake `window` with the provided storage. We attach to
 * `globalThis` so the helper's `typeof window === "undefined"` check passes.
 */
function installWindow(storage: Storage | (() => never)) {
  type Win = { localStorage: Storage | (() => never) };
  // biome-ignore lint/suspicious/noExplicitAny: minimal test-only window shim.
  (globalThis as unknown as { window: Win }).window = { localStorage: storage } as any;
}

function clearWindow() {
  // biome-ignore lint/suspicious/noExplicitAny: removing the test-only shim.
  delete (globalThis as any).window;
}

describe("theme-storage", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = makeStorage();
    installWindow(storage);
  });

  afterEach(() => {
    clearWindow();
  });

  describe("readStoredTheme", () => {
    it("returns undefined when the key is missing", () => {
      expect(readStoredTheme()).toBeUndefined();
    });

    it("returns the value written by writeStoredTheme (round-trip)", () => {
      writeStoredTheme("dark");
      expect(readStoredTheme()).toBe("dark");
      // Stored as JSON so the raw form is a quoted string.
      expect(storage.store.get(THEME_STORAGE_KEY)).toBe('"dark"');
    });

    it("returns undefined when stored JSON is malformed", () => {
      storage.setItem(THEME_STORAGE_KEY, "{not json");
      expect(readStoredTheme()).toBeUndefined();
    });

    it("returns undefined when stored value is not a valid ThemeMode", () => {
      storage.setItem(THEME_STORAGE_KEY, JSON.stringify("octarine"));
      expect(readStoredTheme()).toBeUndefined();
    });

    it("returns undefined when localStorage access throws", () => {
      // Replace with a storage whose getItem throws synchronously — mirrors
      // Safari private mode / sandboxed iframe behaviour.
      installWindow({
        ...storage,
        getItem: () => {
          throw new Error("denied");
        },
      } as Storage);
      expect(readStoredTheme()).toBeUndefined();
    });

    it("returns undefined during SSR (no window)", () => {
      clearWindow();
      expect(readStoredTheme()).toBeUndefined();
    });
  });

  describe("writeStoredTheme", () => {
    it("persists all three valid modes", () => {
      for (const mode of ["system", "light", "dark"] as const) {
        writeStoredTheme(mode);
        expect(readStoredTheme()).toBe(mode);
      }
    });

    it("silently no-ops when setItem throws", () => {
      installWindow({
        ...storage,
        setItem: () => {
          throw new Error("quota");
        },
      } as Storage);
      // Should not throw — best-effort persistence is part of the contract.
      expect(() => writeStoredTheme("dark")).not.toThrow();
    });

    it("silently no-ops during SSR", () => {
      clearWindow();
      expect(() => writeStoredTheme("dark")).not.toThrow();
    });
  });

  describe("clearStoredTheme", () => {
    it("removes the stored value", () => {
      writeStoredTheme("dark");
      expect(readStoredTheme()).toBe("dark");
      clearStoredTheme();
      expect(readStoredTheme()).toBeUndefined();
    });

    it("silently no-ops when removeItem throws", () => {
      writeStoredTheme("dark");
      installWindow({
        ...storage,
        removeItem: () => {
          throw new Error("denied");
        },
      } as Storage);
      expect(() => clearStoredTheme()).not.toThrow();
    });
  });
});
