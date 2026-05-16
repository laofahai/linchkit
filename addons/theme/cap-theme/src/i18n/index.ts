/**
 * Capability-scoped translation bundles for cap-theme.
 *
 * Side-effect-only import: registering the bundle on the shared react-i18next
 * instance (owned by `@linchkit/cap-adapter-ui`) is enough for `t("theme.…")`
 * to resolve from anywhere inside the app. Using `addResourceBundle(deep,
 * overwrite)` keeps re-imports under HMR / test isolation idempotent and
 * leaves the host's `translation` namespace intact.
 *
 * Layout matches `linch i18n-check` discovery: one JSON file per locale
 * under `src/i18n/locales/`, keyed by BCP-47 language tag.
 */

import { i18n } from "@linchkit/cap-adapter-ui";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

const RESOURCES = {
  en,
  "zh-CN": zhCN,
} as const;

for (const [locale, resource] of Object.entries(RESOURCES)) {
  i18n.addResourceBundle(locale, "translation", resource, true, true);
}

export { RESOURCES };
