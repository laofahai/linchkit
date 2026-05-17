/**
 * i18n smoke test for cap-view-kanban.
 *
 * Verifies that:
 *  1. Both shipped locales (`en`, `zh-CN`) resolve every key surfaced by
 *     KanbanBoard / KanbanCard / KanbanColumn, including the i18next plural
 *     forms used for `itemsCount` and `recordsCount`.
 *  2. The capability re-registers its bundles on demand, so a host that
 *     resets the shared i18next instance (or a test that wipes the
 *     namespace) can rebuild the state by calling
 *     `registerKanbanI18nResources()` directly.
 *
 * The test imports `../src/index` for its side effect (the bare `./i18n`
 * import there primes the shared instance) and then exercises the exposed
 * bootstrap function as a second-pass sanity check.
 */

import { describe, expect, test } from "bun:test";
import { i18n } from "@linchkit/cap-adapter-ui";
import { registerKanbanI18nResources } from "../src/index";

const LOCALES = ["en", "zh-CN"] as const;

/** Keys we promise will resolve in every locale. Plural forms go through `t()` with `count`. */
const STATIC_KEYS = [
  "kanban.board.error.title",
  "kanban.board.error.description",
  "kanban.board.error.unknownSource",
  "kanban.column.empty",
] as const;

const PLURAL_KEYS = ["kanban.card.itemsCount", "kanban.column.recordsCount"] as const;

describe("cap-view-kanban i18n bundles", () => {
  test("module-load side effect primes both locales", () => {
    for (const locale of LOCALES) {
      expect(i18n.hasResourceBundle(locale, "translation")).toBe(true);
    }
  });

  test.each(LOCALES)("locale %s resolves every static key to a non-empty string", (locale) => {
    for (const key of STATIC_KEYS) {
      const value = i18n.getFixedT(locale, "translation")(key);
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      // Guard against i18next's "key returned as-is" missing-key fallback.
      expect(value).not.toBe(key);
    }
  });

  test.each(LOCALES)("locale %s renders plural keys for count 1 and count 5", (locale) => {
    const t = i18n.getFixedT(locale, "translation");
    for (const key of PLURAL_KEYS) {
      const singular = t(key, { count: 1 });
      const plural = t(key, { count: 5 });
      expect(singular).not.toBe(key);
      expect(plural).not.toBe(key);
      // The interpolated count must appear in the rendered string so the
      // caller can trust the label to communicate the actual quantity.
      expect(singular).toContain("1");
      expect(plural).toContain("5");
    }
  });

  test("registerKanbanI18nResources is idempotent", () => {
    // Re-running the bootstrap must not throw and must keep the bundles
    // resolvable — this is the contract HMR and host re-mounts rely on.
    expect(() => registerKanbanI18nResources()).not.toThrow();
    for (const locale of LOCALES) {
      expect(i18n.hasResourceBundle(locale, "translation")).toBe(true);
    }
  });
});
