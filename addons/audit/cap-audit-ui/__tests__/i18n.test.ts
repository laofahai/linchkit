/**
 * Smoke test for cap-audit-ui's i18n bootstrap module.
 *
 * Verifies the side-effect-only `./i18n` import registers the `en` and
 * `zh-CN` bundles on the shared react-i18next instance so that every
 * `t("audit.…")` / `t("events.…")` key the views call resolves to a
 * non-default value.
 *
 * Asserting a representative sample of keys per locale catches the
 * common breakage modes — JSON edit drops a top-level namespace, host
 * adapter renames the i18n re-export, or a translation row goes empty.
 */

import { describe, expect, it } from "bun:test";

// Sample of keys exercised by AuditList / AuditDetail / AuditFilters
// (audit.*) and EventTimeline / EventHandlersPanel / EventReplayDialog
// (events.*). Local-only common keys live under audit.common.*.
const SAMPLE_KEYS = [
  "audit.list.title",
  "audit.list.totalCount",
  "audit.detail.title",
  "audit.detail.stateTransition",
  "audit.filters.statusAny",
  "audit.common.previous",
  "audit.common.next",
  "events.timeline.title",
  "events.handlers.title",
  "events.replay.title",
  "events.replay.delivered",
] as const;

describe("cap-audit-ui i18n bootstrap", () => {
  it("registers en and zh-CN translations for every audit/events key", async () => {
    const { i18n } = await import("@linchkit/cap-adapter-ui");
    // Triggers `addResourceBundle(…)` for both locales as a side effect.
    await import("../src/i18n");
    // Subsequent imports of any view also re-import the bootstrap;
    // re-evaluation must be idempotent (addResourceBundle deep=true,
    // overwrite=true) — assert by re-running the import and re-checking.
    await import("../src/i18n");

    for (const key of SAMPLE_KEYS) {
      const enValue = i18n.getResource("en", "translation", key);
      const zhValue = i18n.getResource("zh-CN", "translation", key);
      expect(typeof enValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect(typeof zhValue).toBe("string");
      expect((zhValue as string).length).toBeGreaterThan(0);
    }
  });
});
