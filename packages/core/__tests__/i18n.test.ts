/**
 * Core i18n label resolver tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  detectLocale,
  initI18n,
  registerTranslations,
  resolveLabel,
} from "../src/i18n/label-resolver";
import { _resetI18n } from "../src/i18n/label-resolver";

describe("core i18n label resolver", () => {
  beforeEach(async () => {
    _resetI18n();
    // Initialize with English locale for deterministic tests
    await initI18n({ locale: "en", fallbackLocale: "en" });
  });

  afterEach(() => {
    _resetI18n();
  });

  test("resolveLabel returns literal for non-t: prefix", () => {
    expect(resolveLabel("Purchase Request", "fallback")).toBe("Purchase Request");
  });

  test("resolveLabel returns fallback for undefined label", () => {
    expect(resolveLabel(undefined, "my_fallback")).toBe("my_fallback");
  });

  test("resolveLabel with t: prefix and registered translation returns translated text", () => {
    registerTranslations("demo", "en", {
      entities: {
        purchase_request: {
          _label: "Purchase Request",
        },
      },
    });

    const result = resolveLabel("t:entities.purchase_request._label", "fallback");
    expect(result).toBe("Purchase Request");
  });

  test("resolveLabel with t: prefix and missing translation returns fallback", () => {
    const result = resolveLabel("t:nonexistent.key.path", "My Fallback");
    expect(result).toBe("My Fallback");
  });

  test("registerTranslations adds resources that resolveLabel can find", () => {
    registerTranslations("test-cap", "en", {
      actions: {
        submit_order: "Submit Order",
      },
    });

    expect(resolveLabel("t:actions.submit_order", "fallback")).toBe("Submit Order");
  });

  test("registerTranslations merges multiple namespaces", () => {
    registerTranslations("cap-a", "en", {
      entities: { order: { _label: "Order" } },
    });
    registerTranslations("cap-b", "en", {
      entities: { invoice: { _label: "Invoice" } },
    });

    expect(resolveLabel("t:entities.order._label", "fallback")).toBe("Order");
    expect(resolveLabel("t:entities.invoice._label", "fallback")).toBe("Invoice");
  });

  test("initI18n is idempotent (can be called multiple times safely)", async () => {
    // Already initialized in beforeEach
    await initI18n({ locale: "zh-CN" });
    // Should not throw or change behavior since already initialized
    registerTranslations("test", "en", { foo: "bar" });
    expect(resolveLabel("t:foo", "fallback")).toBe("bar");
  });
});

describe("detectLocale", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env.LANG = originalEnv.LANG;
    process.env.LC_ALL = originalEnv.LC_ALL;
    process.env.LANGUAGE = originalEnv.LANGUAGE;
  });

  test("parses zh_CN.UTF-8 to zh-CN", () => {
    process.env.LANG = "zh_CN.UTF-8";
    process.env.LC_ALL = "";
    process.env.LANGUAGE = "";
    expect(detectLocale()).toBe("zh-CN");
  });

  test("parses en_US.UTF-8 to en-US", () => {
    process.env.LANG = "en_US.UTF-8";
    process.env.LC_ALL = "";
    process.env.LANGUAGE = "";
    expect(detectLocale()).toBe("en-US");
  });

  test("parses simple locale like 'en' to en", () => {
    process.env.LANG = "en";
    process.env.LC_ALL = "";
    process.env.LANGUAGE = "";
    expect(detectLocale()).toBe("en");
  });

  test("returns 'en' when no env vars set", () => {
    process.env.LANG = "";
    process.env.LC_ALL = "";
    process.env.LANGUAGE = "";
    expect(detectLocale()).toBe("en");
  });

  test("uses LC_ALL when LANG is empty", () => {
    process.env.LANG = "";
    process.env.LC_ALL = "ja_JP.UTF-8";
    process.env.LANGUAGE = "";
    expect(detectLocale()).toBe("ja-JP");
  });
});
