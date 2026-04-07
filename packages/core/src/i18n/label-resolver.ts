/**
 * Core i18n label resolver — resolves "t:" prefixed labels using i18next.
 *
 * Provides a standalone i18next instance (separate from react-i18next in the UI)
 * so that CLI, MCP dev server, and any non-React context can resolve
 * translatable labels to human-readable strings.
 *
 * Capabilities register their translation resources via extensions.i18n.
 */

import i18next, { type i18n } from "i18next";

const I18N_PREFIX = "t:";

// Singleton i18next instance for core (non-React) usage
const coreI18n: i18n = i18next.createInstance();

let initialized = false;

/** Initialize the core i18n instance */
async function initI18n(options?: {
  locale?: string;
  fallbackLocale?: string;
}): Promise<void> {
  if (initialized) return;
  const locale = options?.locale ?? detectLocale();
  const fallbackLocale = options?.fallbackLocale ?? "en";

  await coreI18n.init({
    lng: locale,
    fallbackLng: fallbackLocale,
    interpolation: { escapeValue: false },
    // Use "translation" as the default namespace; capabilities add bundles here
    defaultNS: "translation",
    ns: ["translation"],
    resources: {},
  });

  initialized = true;
}

/** Register translation resources from a capability */
function registerTranslations(
  namespace: string,
  locale: string,
  resources: Record<string, unknown>,
): void {
  coreI18n.addResourceBundle(locale, namespace, resources, true, true);
  // Also merge into the default "translation" namespace so flat key lookups work
  coreI18n.addResourceBundle(locale, "translation", resources, true, true);
}

/**
 * Resolve a label — if it starts with "t:", look up via i18next.
 * Otherwise return the label as-is.
 */
function resolveLabel(label: string | undefined, fallback: string): string {
  if (!label) return fallback;
  if (!label.startsWith(I18N_PREFIX)) return label;
  const key = label.slice(I18N_PREFIX.length);
  // Try to translate, fall back to the fallback string
  const result = coreI18n.t(key, { defaultValue: fallback });
  return typeof result === "string" ? result : fallback;
}

/** Detect locale from OS environment */
function detectLocale(): string {
  const env =
    (typeof process !== "undefined" &&
      (process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE)) ||
    "";
  // "zh_CN.UTF-8" -> "zh-CN", "en_US.UTF-8" -> "en"
  const match = env.match(/^([a-z]{2})[-_]?([A-Z]{2})?/i);
  if (match) {
    const lang = match[1]?.toLowerCase() ?? "";
    const region = match[2]?.toUpperCase();
    if (region) return `${lang}-${region}`;
    return lang;
  }
  return "en";
}

/**
 * Reset internal state — for testing only.
 * @internal
 */
function _resetI18n(): void {
  initialized = false;
}

export { coreI18n, detectLocale, initI18n, registerTranslations, resolveLabel, _resetI18n };
