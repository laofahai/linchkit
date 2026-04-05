/**
 * Tests for the shared i18n module (packages/core/src/i18n/index.ts)
 */

import { describe, expect, it } from "bun:test";
import {
  type I18nConfig,
  normalizeTranslatableValue,
  parseAcceptLanguage,
  resolveLocale,
  resolveTranslatableValue,
  type SupportedLanguage,
} from "../src/i18n";

describe("parseAcceptLanguage", () => {
  it("returns undefined for null/undefined/empty", () => {
    expect(parseAcceptLanguage(null)).toBeUndefined();
    expect(parseAcceptLanguage(undefined)).toBeUndefined();
    expect(parseAcceptLanguage("")).toBeUndefined();
  });

  it("extracts single locale", () => {
    expect(parseAcceptLanguage("zh-CN")).toBe("zh-CN");
    expect(parseAcceptLanguage("en")).toBe("en");
  });

  it("extracts first locale from comma-separated list", () => {
    expect(parseAcceptLanguage("zh-CN,en-US;q=0.9,en;q=0.8")).toBe("zh-CN");
  });

  it("extracts first locale before quality value", () => {
    expect(parseAcceptLanguage("en-US;q=0.9")).toBe("en-US");
  });

  it("trims whitespace", () => {
    expect(parseAcceptLanguage("  fr-FR , en-US ")).toBe("fr-FR");
  });
});

describe("resolveLocale", () => {
  it("uses explicit locale when provided", () => {
    expect(resolveLocale({ locale: "zh-CN", acceptLanguage: "en", defaultLocale: "en" })).toBe(
      "zh-CN",
    );
  });

  it("falls back to Accept-Language when no explicit locale", () => {
    expect(resolveLocale({ acceptLanguage: "fr-FR,en;q=0.9", defaultLocale: "en" })).toBe("fr-FR");
  });

  it("falls back to defaultLocale when no explicit locale or Accept-Language", () => {
    expect(resolveLocale({ defaultLocale: "en" })).toBe("en");
  });

  it("returns undefined when nothing is provided", () => {
    expect(resolveLocale({})).toBeUndefined();
  });

  it("explicit locale takes priority over Accept-Language", () => {
    expect(resolveLocale({ locale: "ja", acceptLanguage: "zh-CN" })).toBe("ja");
  });
});

describe("i18n module re-exports", () => {
  it("re-exports resolveTranslatableValue", () => {
    const value = { en: "Hello", "zh-CN": "你好" };
    expect(resolveTranslatableValue(value, "en")).toBe("Hello");
    expect(resolveTranslatableValue(value, "zh-CN")).toBe("你好");
  });

  it("re-exports normalizeTranslatableValue", () => {
    const result = normalizeTranslatableValue("Hello", "en");
    expect(result).toEqual({ en: "Hello" });
  });
});

describe("I18nConfig type", () => {
  it("should accept valid I18nConfig", () => {
    const config: I18nConfig = {
      defaultLocale: "en",
      supportedLocales: ["en", "zh-CN", "ja"],
    };
    expect(config.defaultLocale).toBe("en");
    expect(config.supportedLocales).toHaveLength(3);
  });

  it("should allow partial I18nConfig (no supportedLocales)", () => {
    const config: I18nConfig = { defaultLocale: "zh-CN" };
    expect(config.defaultLocale).toBe("zh-CN");
    expect(config.supportedLocales).toBeUndefined();
  });
});

describe("SupportedLanguage type", () => {
  it("should accept common locale strings", () => {
    const locales: SupportedLanguage[] = ["en", "zh-CN", "ja", "fr", "de", "es", "ko"];
    expect(locales).toHaveLength(7);
  });

  it("should accept arbitrary BCP 47 strings via open union", () => {
    const custom: SupportedLanguage = "tlh-KX"; // Klingon :)
    expect(typeof custom).toBe("string");
  });
});
