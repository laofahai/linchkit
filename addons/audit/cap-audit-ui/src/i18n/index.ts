/**
 * Capability-scoped translation bundles for cap-audit-ui.
 *
 * Registers `en` and `zh-CN` resources on the shared react-i18next
 * instance owned by `@linchkit/cap-adapter-ui`. Loading is side-effect-only:
 * importing the module is enough to make every `t("audit.…")` /
 * `t("events.…")` key resolve at render time. Importing again
 * (re-evaluation under HMR / test isolation) is safe —
 * `addResourceBundle(deep=true, overwrite=true)` merges idempotently.
 *
 * Layout matches `linch i18n-check` discovery: one JSON file per locale
 * under `src/i18n/locales/`, keyed by BCP-47 language tag. The host i18n
 * runtime in cap-adapter-ui is the single source of truth for the active
 * language and the fallback chain.
 *
 * Mirrors the bootstrap pattern from cap-search-ui to avoid creating a
 * new shared package — see KISS guideline in CLAUDE.md.
 */

import { i18n } from "@linchkit/cap-adapter-ui";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/** Locale code → resource map, used to seed the shared i18next instance. */
const RESOURCES = {
  en,
  "zh-CN": zhCN,
} as const;

// `deep=true` so existing bundles (cap-adapter-ui's "translation" namespace)
// are merged rather than replaced; `overwrite=true` ensures HMR re-imports
// pick up edits to the JSON without a full reload.
export function registerAuditI18nResources(): void {
  for (const [locale, resource] of Object.entries(RESOURCES)) {
    i18n.addResourceBundle(locale, "translation", resource, true, true);
  }
}

registerAuditI18nResources();

export { RESOURCES };
