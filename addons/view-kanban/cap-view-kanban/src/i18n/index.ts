/**
 * Capability-scoped translation bundles for cap-view-kanban.
 *
 * Registers `en` and `zh-CN` resources on the shared react-i18next
 * instance owned by `@linchkit/cap-adapter-ui`. Loading is side-effect-only
 * at module evaluation, but the bootstrap is also exposed as
 * `registerKanbanI18nResources()` so tests and host bundles can re-prime
 * the registry on demand (e.g. after a manual `i18n.removeResourceBundle`).
 *
 * Layout matches `linch i18n-check` discovery: one JSON file per locale
 * under `src/i18n/locales/`, keyed by BCP-47 language tag. The host i18n
 * runtime in cap-adapter-ui is the single source of truth for the active
 * language and the fallback chain.
 */

import { i18n } from "@linchkit/cap-adapter-ui";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/** Locale code → resource map, used to seed the shared i18next instance. */
export const RESOURCES = {
  en,
  "zh-CN": zhCN,
} as const;

/**
 * Merge cap-view-kanban locale bundles into the shared i18next instance.
 *
 * `deep=true` so existing bundles (cap-adapter-ui's "translation" namespace)
 * are merged rather than replaced; `overwrite=true` ensures HMR re-imports
 * and tests that re-run this bootstrap pick up edits without a full reload.
 *
 * Safe to call multiple times — `addResourceBundle` is idempotent under the
 * deep-merge flags above.
 */
export function registerKanbanI18nResources(): void {
  for (const [locale, resource] of Object.entries(RESOURCES)) {
    i18n.addResourceBundle(locale, "translation", resource, true, true);
  }
}

// Side-effect: register at module load so a bare `import "./i18n"` from the
// capability entry point primes the shared instance before any view renders.
registerKanbanI18nResources();
