/**
 * i18n configuration for @linchkit/ui
 *
 * Uses i18next + react-i18next for frontend internationalization.
 * Supports English (en) and Simplified Chinese (zh-CN).
 * Language is auto-detected from browser settings with fallback to English.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/** Supported language codes */
export const supportedLanguages = ["en", "zh-CN"] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

/** Language display names */
export const languageNames: Record<SupportedLanguage, string> = {
	en: "English",
	"zh-CN": "中文",
};

/** Detect browser language, mapping to supported languages */
function detectBrowserLanguage(): SupportedLanguage {
	if (typeof navigator === "undefined") return "en";

	const browserLang = navigator.language;

	// Exact match
	if (supportedLanguages.includes(browserLang as SupportedLanguage)) {
		return browserLang as SupportedLanguage;
	}

	// Prefix match (e.g., "zh" -> "zh-CN", "en-US" -> "en")
	if (browserLang.startsWith("zh")) return "zh-CN";
	if (browserLang.startsWith("en")) return "en";

	return "en";
}

/** Get persisted language from localStorage, or detect from browser */
function getInitialLanguage(): SupportedLanguage {
	if (typeof localStorage !== "undefined") {
		const stored = localStorage.getItem("linchkit-language");
		if (
			stored &&
			supportedLanguages.includes(stored as SupportedLanguage)
		) {
			return stored as SupportedLanguage;
		}
	}
	return detectBrowserLanguage();
}

i18n.use(initReactI18next).init({
	resources: {
		en: { translation: en },
		"zh-CN": { translation: zhCN },
	},
	lng: getInitialLanguage(),
	fallbackLng: "en",
	interpolation: {
		escapeValue: false, // React already handles escaping
	},
});

/** Change language and persist to localStorage */
export function changeLanguage(lang: SupportedLanguage): void {
	i18n.changeLanguage(lang);
	if (typeof localStorage !== "undefined") {
		localStorage.setItem("linchkit-language", lang);
	}
}

export default i18n;
