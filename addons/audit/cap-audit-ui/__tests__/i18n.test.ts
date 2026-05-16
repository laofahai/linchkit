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
  "audit.list.totalCount_one",
  "audit.list.totalCount_other",
  "audit.detail.title",
  "audit.detail.stateTransition",
  "audit.filters.statusAny",
  "audit.common.previous",
  "audit.common.next",
  "events.timeline.title",
  "events.timeline.totalCount_other",
  "events.handlers.title",
  "events.replay.title",
  "events.replay.delivered",
] as const;

describe("cap-audit-ui i18n bootstrap", () => {
  it("registers en and zh-CN translations for every audit/events key", async () => {
    const { i18n } = await import("@linchkit/cap-adapter-ui");
    const { registerAuditI18nResources } = await import("../src/i18n");

    // Explicit second call validates the bootstrap is idempotent;
    // `addResourceBundle(deep=true, overwrite=true)` must merge without
    // tearing down the host's existing "translation" namespace.
    registerAuditI18nResources();

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
