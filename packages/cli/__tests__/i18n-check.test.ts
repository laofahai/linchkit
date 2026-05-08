/**
 * Tests for `linch i18n check` — pure helpers + CLI integration.
 *
 * Pure helpers (`flattenLocale`, `compareLocales`, `discoverLocaleGroups`,
 * `checkCapability`) are tested directly to avoid CLI-spawn overhead. One
 * end-to-end fixture is exercised via `discoverLocaleGroups + checkCapability`
 * to confirm wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkCapability,
  compareLocales,
  discoverLocaleGroups,
  flattenLocale,
  type LocaleTree,
} from "../src/commands/i18n-check";

describe("flattenLocale", () => {
  it("flattens a flat object 1:1", () => {
    expect(flattenLocale({ a: "1", b: "2" })).toEqual({ a: "1", b: "2" });
  });

  it("flattens nested keys with dot notation", () => {
    const tree: LocaleTree = { common: { submit: "Submit", cancel: "Cancel" }, top: "Top" };
    expect(flattenLocale(tree)).toEqual({
      "common.submit": "Submit",
      "common.cancel": "Cancel",
      top: "Top",
    });
  });

  it("coerces non-string leaves to string instead of recursing into arrays", () => {
    // Arrays aren't valid LocaleTree leaves but a real i18n file might slip
    // one in; we coerce, never recurse.
    const tree = { count: 7 as unknown as string, list: ["a", "b"] as unknown as string };
    expect(flattenLocale(tree as LocaleTree)).toEqual({ count: "7", list: "a,b" });
  });

  it("does not mutate the input", () => {
    const tree: LocaleTree = { a: { b: "x" } };
    const snapshot = JSON.stringify(tree);
    flattenLocale(tree);
    expect(JSON.stringify(tree)).toBe(snapshot);
  });
});

describe("compareLocales", () => {
  it("reports no issues when locales are identical", () => {
    const issues = compareLocales({
      en: { "common.ok": "OK" },
      "zh-CN": { "common.ok": "好" },
    });
    expect(issues).toEqual([]);
  });

  it("reports a missing key in the locale that lacks it", () => {
    const issues = compareLocales({
      en: { "common.ok": "OK", "common.cancel": "Cancel" },
      "zh-CN": { "common.ok": "好" },
    });
    const kinds = issues.map((i) => `${i.kind}:${i.locale}:${i.key}`);
    expect(kinds).toContain("missing:zh-CN:common.cancel");
    // "extra" is the symmetric counterpart, only when exactly one locale has it.
    expect(kinds).toContain("extra:en:common.cancel");
  });

  it("reports an empty value as kind=empty", () => {
    const issues = compareLocales({
      en: { "common.ok": "OK", "common.cancel": "" },
      "zh-CN": { "common.ok": "好", "common.cancel": "取消" },
    });
    const empties = issues.filter((i) => i.kind === "empty");
    expect(empties.length).toBe(1);
    expect(empties[0]?.locale).toBe("en");
    expect(empties[0]?.key).toBe("common.cancel");
  });

  it("treats whitespace-only values as empty", () => {
    const issues = compareLocales({
      en: { greeting: "   " },
      "zh-CN": { greeting: "你好" },
    });
    expect(issues.some((i) => i.kind === "empty" && i.locale === "en")).toBe(true);
  });

  it("does not emit 'extra' when more than one locale has the key (only 'missing')", () => {
    const issues = compareLocales({
      en: { a: "1" },
      "zh-CN": { a: "1" },
      fr: {},
    });
    const extras = issues.filter((i) => i.kind === "extra");
    expect(extras).toEqual([]);
    const missing = issues.filter((i) => i.kind === "missing" && i.locale === "fr");
    expect(missing.length).toBe(1);
  });
});

describe("discoverLocaleGroups + checkCapability (end-to-end via fixture)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = resolve(
      process.env.TMPDIR ?? "/tmp",
      `linchkit-i18n-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Best effort — the OS will reap the tmp tree later.
    }
  });

  function writeLocale(capPath: string, layout: "flat" | "nested", locale: string, body: object) {
    const dir =
      layout === "flat" ? resolve(capPath, "src/i18n") : resolve(capPath, "src/i18n/locales");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${locale}.json`), JSON.stringify(body, null, 2));
  }

  it("returns empty when there is no `addons/` directory", () => {
    expect(discoverLocaleGroups(tmpRoot)).toEqual([]);
  });

  it("discovers groups under both flat and nested layouts", () => {
    const flatCap = resolve(tmpRoot, "addons/group-a/cap-flat");
    writeLocale(flatCap, "flat", "en", { hello: "Hi" });
    writeLocale(flatCap, "flat", "zh-CN", { hello: "你好" });

    const nestedCap = resolve(tmpRoot, "addons/group-b/cap-nested");
    writeLocale(nestedCap, "nested", "en", { fresh: "fresh" });
    writeLocale(nestedCap, "nested", "zh-CN", { fresh: "鲜" });

    const groups = discoverLocaleGroups(tmpRoot);
    expect(groups.map((g) => g.capability).sort()).toEqual([
      "addons/group-a/cap-flat",
      "addons/group-b/cap-nested",
    ]);
    const nestedGroup = groups.find((g) => g.capability === "addons/group-b/cap-nested");
    expect(nestedGroup?.dir.endsWith("locales")).toBe(true);
  });

  it("unions flat + nested layouts during partial migration (no locale dropped)", async () => {
    // A capability mid-migration: `en` already moved to `locales/`,
    // `zh-CN` still flat in `i18n/`. Discovery must surface BOTH so the
    // check doesn't false-positive a missing locale.
    const capPath = resolve(tmpRoot, "addons/g/cap-partial");
    writeLocale(capPath, "nested", "en", { hello: "Hi" });
    writeLocale(capPath, "flat", "zh-CN", { hello: "你好" });

    const groups = discoverLocaleGroups(tmpRoot);
    expect(groups.length).toBe(1);
    expect(Object.keys(groups[0]?.locales ?? {}).sort()).toEqual(["en", "zh-CN"]);

    const report = await checkCapability(groups[0] as LocaleGroup);
    expect(report.skipped).toBeUndefined();
    expect(report.issues).toEqual([]);
  });

  it("on same-locale collision, nested layout wins", async () => {
    // Both layouts contain `en.json`. Post-migration intent is that
    // `locales/en.json` is the source of truth.
    const capPath = resolve(tmpRoot, "addons/g/cap-collision");
    writeLocale(capPath, "flat", "en", { stale: "stale-value" });
    writeLocale(capPath, "nested", "en", { fresh: "fresh-value" });
    writeLocale(capPath, "nested", "zh-CN", { fresh: "鲜" });

    const groups = discoverLocaleGroups(tmpRoot);
    const report = await checkCapability(groups[0] as LocaleGroup);
    // Should compare the FRESH `en` (from locales/) against `zh-CN`,
    // surfacing only `fresh` as the cross-locale key.
    expect(report.issues.some((i) => i.key === "stale")).toBe(false);
    expect(report.issues.some((i) => i.key === "fresh")).toBe(false);
  });

  it("checkCapability returns OK for matching locales", async () => {
    const capPath = resolve(tmpRoot, "addons/g/cap-ok");
    writeLocale(capPath, "flat", "en", { hello: "Hi" });
    writeLocale(capPath, "flat", "zh-CN", { hello: "你好" });

    const groups = discoverLocaleGroups(tmpRoot);
    const report = await checkCapability(groups[0] as LocaleGroup);
    expect(report.skipped).toBeUndefined();
    expect(report.issues).toEqual([]);
  });

  it("checkCapability finds nested-key mismatches", async () => {
    const capPath = resolve(tmpRoot, "addons/g/cap-mismatch");
    writeLocale(capPath, "flat", "en", { common: { submit: "Submit", cancel: "Cancel" } });
    writeLocale(capPath, "flat", "zh-CN", { common: { submit: "提交" } });

    const groups = discoverLocaleGroups(tmpRoot);
    const report = await checkCapability(groups[0] as LocaleGroup);
    expect(report.issues.some((i) => i.kind === "missing" && i.key === "common.cancel")).toBe(true);
  });

  it("checkCapability marks single-locale capabilities as skipped, not failed", async () => {
    const capPath = resolve(tmpRoot, "addons/g/cap-single");
    writeLocale(capPath, "flat", "en", { hello: "Hi" });

    const groups = discoverLocaleGroups(tmpRoot);
    const report = await checkCapability(groups[0] as LocaleGroup);
    expect(report.skipped).toBeDefined();
    expect(report.issues).toEqual([]);
  });

  it("checkCapability reports a parse error as skipped, not crashed", async () => {
    const capPath = resolve(tmpRoot, "addons/g/cap-bad-json");
    const dir = resolve(capPath, "src/i18n");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "en.json"), "{not valid json");
    writeFileSync(resolve(dir, "zh-CN.json"), JSON.stringify({ ok: "ok" }));

    const groups = discoverLocaleGroups(tmpRoot);
    const report = await checkCapability(groups[0] as LocaleGroup);
    expect(report.skipped).toBeDefined();
    expect(report.skipped).toContain("failed to parse");
  });
});
