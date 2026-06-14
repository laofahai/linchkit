/**
 * Unit tests for the deterministic `sync-core-version` logic (issue #589).
 *
 * Exercises the PURE sync functions against in-memory fixtures (no filesystem,
 * no real version bump): a JSON package.json/capability.json site, the cap-lock
 * factory.ts literal, and the cap-lock test assertion literal. Covers the happy
 * path, idempotency, drift detection, and edge cases (alt quote style,
 * whitespace, non-JSON/no-field inputs, trailing-newline preservation).
 */

import { describe, expect, test } from "bun:test";
import {
  applySync,
  coreVersionRange,
  readCoreVersion,
  syncFactoryCoreVersion,
  syncJsonCoreVersion,
  syncTestCoreVersion,
} from "../sync-core-version";

// -- coreVersionRange / readCoreVersion ----------------------------------

describe("coreVersionRange", () => {
  test("builds a caret range from a concrete version", () => {
    expect(coreVersionRange("0.3.0")).toBe("^0.3.0");
    expect(coreVersionRange("1.2.3")).toBe("^1.2.3");
  });
});

describe("readCoreVersion", () => {
  test("reads the .version field", () => {
    expect(readCoreVersion('{ "name": "@linchkit/core", "version": "0.4.0" }')).toBe("0.4.0");
  });

  test("throws when version is missing", () => {
    expect(() => readCoreVersion('{ "name": "@linchkit/core" }')).toThrow();
  });
});

// -- syncJsonCoreVersion -------------------------------------------------

describe("syncJsonCoreVersion", () => {
  const pkg = (cv: string) =>
    `${JSON.stringify({ name: "@linchkit/cap-x", linchkit: { coreVersion: cv } }, null, 2)}\n`;

  test("rewrites a stale coreVersion to the target range", () => {
    const { text, changed } = syncJsonCoreVersion(pkg("^0.2.0"), "^0.3.0");
    expect(changed).toBe(true);
    const parsed = JSON.parse(text) as { linchkit: { coreVersion: string } };
    expect(parsed.linchkit.coreVersion).toBe("^0.3.0");
  });

  test("preserves 2-space indent and trailing newline", () => {
    const { text } = syncJsonCoreVersion(pkg("^0.2.0"), "^0.3.0");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "linchkit": {');
    expect(text).toContain('\n    "coreVersion": "^0.3.0"');
  });

  test("is idempotent when already in sync (no change)", () => {
    const inSync = pkg("^0.3.0");
    const { text, changed } = syncJsonCoreVersion(inSync, "^0.3.0");
    expect(changed).toBe(false);
    expect(text).toBe(inSync);
  });

  test("detects drift (changed flag) without a coreVersion field returns unchanged", () => {
    const noField = `${JSON.stringify({ name: "@linchkit/cap-x", linchkit: {} }, null, 2)}\n`;
    const { changed } = syncJsonCoreVersion(noField, "^0.3.0");
    expect(changed).toBe(false);
  });

  test("ignores a package.json without a linchkit block", () => {
    const plain = `${JSON.stringify({ name: "x", version: "1.0.0" }, null, 2)}\n`;
    const { text, changed } = syncJsonCoreVersion(plain, "^0.3.0");
    expect(changed).toBe(false);
    expect(text).toBe(plain);
  });

  test("does not invent a trailing newline that was absent", () => {
    const noNewline = JSON.stringify({ name: "x", linchkit: { coreVersion: "^0.2.0" } }, null, 2);
    const { text } = syncJsonCoreVersion(noNewline, "^0.3.0");
    expect(text.endsWith("\n")).toBe(false);
  });
});

// -- syncFactoryCoreVersion ----------------------------------------------

describe("syncFactoryCoreVersion", () => {
  const factory = (cv: string) =>
    [
      "return defineCapability({",
      '  name: "cap-lock",',
      '  version: "1.0.0",',
      `  coreVersion: "${cv}",`,
      "});",
    ].join("\n");

  test("rewrites the coreVersion literal", () => {
    const { text, changed } = syncFactoryCoreVersion(factory("^0.2.0"), "^0.3.0");
    expect(changed).toBe(true);
    expect(text).toContain('coreVersion: "^0.3.0"');
    expect(text).not.toContain("^0.2.0");
  });

  test("is idempotent when already in sync", () => {
    const inSync = factory("^0.3.0");
    const { text, changed } = syncFactoryCoreVersion(inSync, "^0.3.0");
    expect(changed).toBe(false);
    expect(text).toBe(inSync);
  });

  test("tolerates single quotes and extra whitespace", () => {
    const src = "coreVersion :   '^0.1.0'";
    const { text, changed } = syncFactoryCoreVersion(src, "^0.3.0");
    expect(changed).toBe(true);
    expect(text).toBe("coreVersion :   '^0.3.0'");
  });

  test("leaves source untouched when there is no coreVersion property", () => {
    const src = 'const x = "^0.2.0";';
    const { text, changed } = syncFactoryCoreVersion(src, "^0.3.0");
    expect(changed).toBe(false);
    expect(text).toBe(src);
  });
});

// -- syncTestCoreVersion -------------------------------------------------

describe("syncTestCoreVersion", () => {
  const assertion = (cv: string) => `    expect(capLock.coreVersion).toBe("${cv}");`;

  test("rewrites the asserted version literal", () => {
    const { text, changed } = syncTestCoreVersion(assertion("^0.2.0"), "^0.3.0");
    expect(changed).toBe(true);
    expect(text).toBe(assertion("^0.3.0"));
  });

  test("is idempotent when already in sync", () => {
    const inSync = assertion("^0.3.0");
    const { text, changed } = syncTestCoreVersion(inSync, "^0.3.0");
    expect(changed).toBe(false);
    expect(text).toBe(inSync);
  });

  test("does not touch an unrelated toBe assertion", () => {
    const src = 'expect(capLock.version).toBe("1.0.0");';
    const { text, changed } = syncTestCoreVersion(src, "^0.3.0");
    expect(changed).toBe(false);
    expect(text).toBe(src);
  });
});

// -- applySync dispatcher + full-plan fixture ----------------------------

describe("applySync (full plan over a fake capability set)", () => {
  const coreVersion = "0.4.0";
  const range = coreVersionRange(coreVersion);

  const fixtures: Record<string, { strategy: "json" | "factory" | "test"; before: string }> = {
    "addons/a/cap-a/package.json": {
      strategy: "json",
      before: `${JSON.stringify(
        {
          name: "@linchkit/cap-a",
          peerDependencies: { "@linchkit/core": "^0.3.0" },
          linchkit: { coreVersion: "^0.3.0" },
        },
        null,
        2,
      )}\n`,
    },
    "addons/lock/cap-lock/capability.json": {
      strategy: "json",
      before: `${JSON.stringify(
        { name: "@linchkit/cap-lock", linchkit: { coreVersion: "^0.3.0" } },
        null,
        2,
      )}\n`,
    },
    "addons/lock/cap-lock/src/factory.ts": {
      strategy: "factory",
      before: '  coreVersion: "^0.3.0",',
    },
    "addons/lock/cap-lock/__tests__/capability.test.ts": {
      strategy: "test",
      before: '    expect(capLock.coreVersion).toBe("^0.3.0");',
    },
  };

  test("syncs every site from a fake core bump to ^0.4.0", () => {
    for (const [path, { strategy, before }] of Object.entries(fixtures)) {
      const { text, changed } = applySync(strategy, before, range);
      expect(changed).toBe(true);
      expect(text).toContain(range);
      // The coreVersion-bearing token must move to ^0.4.0. The package.json
      // fixture keeps a peerDependencies "^0.3.0" the sync does NOT own (that
      // is changeset's job), so assert against the coreVersion token only.
      if (path.endsWith("package.json")) {
        const parsed = JSON.parse(text) as { linchkit: { coreVersion: string } };
        expect(parsed.linchkit.coreVersion).toBe(range);
      } else if (path.endsWith("capability.json")) {
        const parsed = JSON.parse(text) as { linchkit: { coreVersion: string } };
        expect(parsed.linchkit.coreVersion).toBe(range);
        expect(text).not.toContain("^0.3.0");
      } else {
        expect(text).not.toContain("^0.3.0");
      }
    }
  });

  test("running the plan a second time is a no-op (idempotent)", () => {
    for (const { strategy, before } of Object.values(fixtures)) {
      const first = applySync(strategy, before, range).text;
      const second = applySync(strategy, first, range);
      expect(second.changed).toBe(false);
      expect(second.text).toBe(first);
    }
  });

  test("detects drift: a stale site reports changed=true", () => {
    const staleFixture = fixtures["addons/a/cap-a/package.json"];
    expect(staleFixture).toBeDefined();
    const stale = applySync("json", (staleFixture as { before: string }).before, range);
    expect(stale.changed).toBe(true);
  });
});
