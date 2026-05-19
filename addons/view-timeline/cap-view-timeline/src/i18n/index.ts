/**
 * Capability-scoped translation bundles for cap-view-timeline.
 *
 * Registers `en` and `zh-CN` resources on the shared react-i18next
 * instance owned by `@linchkit/cap-adapter-ui`. Mirrors the pattern
 * established in cap-view-kanban.
 */

import { i18n } from "@linchkit/cap-adapter-ui";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const RESOURCES = {
  en,
  "zh-CN": zhCN,
} as const;

export function registerTimelineI18nResources(): void {
  for (const [locale, resource] of Object.entries(RESOURCES)) {
    i18n.addResourceBundle(locale, "translation", resource, true, true);
  }
}

registerTimelineI18nResources();
