/**
 * Tests for the theme state machine + matchMedia tracking.
 *
 * The React provider is a thin wrapper over the pure helpers in
 * `transitions.ts` + `system-theme.ts` + `theme-storage.ts`. Exercising those
 * directly keeps the test logic-only (no jsdom, no React renderer) while
 * still covering the three behaviours called out in the task:
 *   - Mode transitions (cycle order)
 *   - Persistence call (storage written on commit)
 *   - `resolvedMode` tracks `matchMedia` while `mode === "system"`
 *
 * We stub `window.matchMedia` and `window.localStorage` per-test so the
 * helpers' SSR / capability guards see the expected shape without us pulling
 * in jsdom.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resolveSystemTheme } from "../src/system-theme";
import { readStoredTheme } from "../src/theme-storage";
import { commitMode, nextMode, resolveMode, THEME_CYCLE } from "../src/transitions";
import { THEME_STORAGE_KEY, type ThemeMode } from "../src/types";

type MqlListener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof mock>;
  removeEventListener: ReturnType<typeof mock>;
  listeners: MqlListener[];
  /** Test helper: dispatch a synthetic change event to all listeners. */
  emit(matches: boolean): void;
}

function makeMql(initialMatches: boolean): FakeMediaQueryList {
  const listeners: MqlListener[] = [];
  const mql: FakeMediaQueryList = {
    matches: initialMatches,
    media: "(prefers-color-scheme: dark)",
    listeners,
    addEventListener: mock((event: string, listener: MqlListener) => {
      if (event === "change") listeners.push(listener);
    }),
    removeEventListener: mock((event: string, listener: MqlListener) => {
      if (event !== "change") return;
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
    emit(matches: boolean) {
      mql.matches = matches;
      const event = { matches } as MediaQueryListEvent;
      for (const fn of [...listeners]) fn(event);
    },
  };
  return mql;
}

interface InstallOptions {
  prefersDark: boolean;
  /** Stored value to seed before the test runs. `undefined` leaves the key absent. */
  initialStored?: ThemeMode;
}

function installWindow({ prefersDark, initialStored }: InstallOptions) {
  const store = new Map<string, string>();
  if (initialStored !== undefined) {
    store.set(THEME_STORAGE_KEY, JSON.stringify(initialStored));
  }
  const storage: Storage = {
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

  const mql = makeMql(prefersDark);
  const matchMedia = mock((_query: string) => mql);

  // biome-ignore lint/suspicious/noExplicitAny: minimal test-only window shim.
  (globalThis as any).window = { localStorage: storage, matchMedia } as any;

  return { mql, matchMedia, store };
}

function clearWindow() {
  // biome-ignore lint/suspicious/noExplicitAny: removing the test-only shim.
  delete (globalThis as any).window;
}

afterEach(() => {
  clearWindow();
});

// ── Mode transitions ────────────────────────────────────────

describe("nextMode (cycle)", () => {
  it("advances system → light → dark → system", () => {
    expect(nextMode("system")).toBe("light");
    expect(nextMode("light")).toBe("dark");
    expect(nextMode("dark")).toBe("system");
  });

  it("matches the exported THEME_CYCLE order", () => {
    expect(THEME_CYCLE).toEqual(["system", "light", "dark"]);
  });

  it("falls back to the first cycle entry for unknown values", () => {
    // Cast through unknown — exercising the defensive branch in nextMode.
    expect(nextMode("octarine" as unknown as ThemeMode)).toBe("system");
  });
});

// ── Persistence call ────────────────────────────────────────

describe("commitMode (persistence)", () => {
  beforeEach(() => {
    installWindow({ prefersDark: false });
  });

  it("writes the chosen mode to storage", () => {
    commitMode("dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("returns the resolved scheme for explicit modes", () => {
    expect(commitMode("light")).toBe("light");
    expect(commitMode("dark")).toBe("dark");
  });

  it("resolves system mode against matchMedia at commit time", () => {
    clearWindow();
    installWindow({ prefersDark: true });
    expect(commitMode("system")).toBe("dark");

    clearWindow();
    installWindow({ prefersDark: false });
    expect(commitMode("system")).toBe("light");
  });
});

// ── resolvedMode tracks matchMedia ──────────────────────────

describe("resolveMode + system-theme", () => {
  it("resolves explicit modes to themselves regardless of OS", () => {
    installWindow({ prefersDark: true });
    expect(resolveMode("light")).toBe("light");
    expect(resolveMode("dark")).toBe("dark");
  });

  it("resolves system mode to dark when the OS prefers dark", () => {
    installWindow({ prefersDark: true });
    expect(resolveMode("system")).toBe("dark");
  });

  it("resolves system mode to light when the OS prefers light", () => {
    installWindow({ prefersDark: false });
    expect(resolveMode("system")).toBe("light");
  });

  it("falls back to light when window is unavailable (SSR)", () => {
    clearWindow();
    expect(resolveSystemTheme()).toBe("light");
    expect(resolveMode("system")).toBe("light");
  });

  it("tracks subsequent matchMedia change events", () => {
    // We model the subscription manually here — the provider attaches the
    // listener via addEventListener, so we assert that emit() flips the
    // observable state.
    const { mql } = installWindow({ prefersDark: false });
    expect(resolveMode("system")).toBe("light");

    // Simulate an OS theme flip; resolveSystemTheme should now report dark.
    mql.emit(true);
    expect(resolveSystemTheme()).toBe("dark");

    mql.emit(false);
    expect(resolveSystemTheme()).toBe("light");
  });
});

// ── Hydration / boot story ──────────────────────────────────

describe("hydration", () => {
  it("readStoredTheme picks up a seeded preference", () => {
    installWindow({ prefersDark: false, initialStored: "dark" });
    expect(readStoredTheme()).toBe("dark");
  });

  it("falls back through the chain stored → default for an empty store", () => {
    installWindow({ prefersDark: false });
    const stored = readStoredTheme();
    const effective = stored ?? ("system" satisfies ThemeMode);
    expect(effective).toBe("system");
    expect(resolveMode(effective)).toBe("light");
  });
});
