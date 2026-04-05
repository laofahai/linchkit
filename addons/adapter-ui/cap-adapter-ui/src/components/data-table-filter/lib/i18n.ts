import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";

export type Locale = "en" | "zh-CN";

type Translations = Record<string, string>;

const translations: Record<Locale, Translations> = {
  en,
  "zh-CN": zhCN,
};

export function t(key: string, locale: Locale): string {
  return translations[locale]?.[key] ?? translations.en[key] ?? key;
}
