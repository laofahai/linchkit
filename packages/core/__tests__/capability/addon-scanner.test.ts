import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanAddonsPath } from "../../src/capability/addon-scanner";
import type { MetadataCompatibility } from "../../src/capability/compatibility";
import { enforceCoreCompatibility } from "../../src/capability/compatibility";

const TMP = join(import.meta.dir, "__tmp_addon_scan__");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeAddon(
  group: string,
  capName: string,
  capDef: string,
  linchkit?: MetadataCompatibility,
) {
  const dir = join(TMP, group, capName, "src");
  mkdirSync(dir, { recursive: true });
  const pkg: Record<string, unknown> = { name: `@linchkit/${capName}`, main: "src/index.ts" };
  if (linchkit) pkg.linchkit = linchkit;
  writeFileSync(join(TMP, group, capName, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(dir, "index.ts"), capDef);
}

describe("scanAddonsPath", () => {
  test("discovers capabilities in addon group directories", async () => {
    makeAddon(
      "test-group",
      "cap-test",
      `
      export default {
        name: "cap-test",
        label: "Test",
        type: "standard",
        category: "business",
        version: "0.1.0",
      };
    `,
    );

    const caps = await scanAddonsPath([TMP]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.name).toBe("cap-test");
  });

  test("ignores non-cap directories", async () => {
    const dir = join(TMP, "group1", "not-a-cap", "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(TMP, "group1", "not-a-cap", "package.json"),
      JSON.stringify({ name: "not-a-cap" }),
    );

    const caps = await scanAddonsPath([TMP]);
    expect(caps).toHaveLength(0);
  });

  test("scans multiple addon paths", async () => {
    const tmp2 = `${TMP}_2`;
    mkdirSync(tmp2, { recursive: true });

    makeAddon(
      "g1",
      "cap-a",
      `
      export default { name: "cap-a", label: "A", type: "standard", category: "business", version: "0.1.0" };
    `,
    );

    const dir2 = join(tmp2, "g2", "cap-b", "src");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      join(tmp2, "g2", "cap-b", "package.json"),
      JSON.stringify({ name: "@linchkit/cap-b", main: "src/index.ts" }),
    );
    writeFileSync(
      `${dir2}/index.ts`,
      `
      export default { name: "cap-b", label: "B", type: "standard", category: "business", version: "0.1.0" };
    `,
    );

    const caps = await scanAddonsPath([TMP, tmp2]);
    expect(caps).toHaveLength(2);

    rmSync(tmp2, { recursive: true, force: true });
  });

  test("returns empty for non-existent path", async () => {
    const caps = await scanAddonsPath(["/non/existent/path"]);
    expect(caps).toHaveLength(0);
  });

  // ── Spec 21 / #122: boot-time coreVersion population ──

  test("populates coreVersion from the addon's package.json linchkit.minCoreVersion", async () => {
    // Shipped addons declare a bare `minCoreVersion` range under `linchkit`.
    // Without population the boot-time compatibility check sees `undefined`.
    makeAddon(
      "test-group",
      "cap-mincore",
      `
      export default {
        name: "cap-mincore",
        label: "MinCore",
        type: "standard",
        category: "business",
        version: "0.1.0",
      };
    `,
      { minCoreVersion: "^0.2.0" },
    );

    const caps = await scanAddonsPath([TMP]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.coreVersion).toBe("^0.2.0");
  });

  test("populates coreVersion even when the addon's default export is frozen", async () => {
    // A frozen default export (or a named-export namespace object) cannot be
    // mutated in place — the scanner must shallow-copy before stamping
    // coreVersion, or the assignment throws and the addon is silently dropped.
    makeAddon(
      "test-group",
      "cap-frozen",
      `
      export default Object.freeze({
        name: "cap-frozen",
        label: "Frozen",
        type: "standard",
        category: "business",
        version: "0.1.0",
      });
    `,
      { minCoreVersion: "^0.2.0" },
    );

    const caps = await scanAddonsPath([TMP]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.coreVersion).toBe("^0.2.0");
  });

  test("normalizes a bare minCoreVersion to a >= range on the runtime definition", async () => {
    makeAddon(
      "test-group",
      "cap-bare",
      `
      export default {
        name: "cap-bare",
        label: "Bare",
        type: "standard",
        category: "business",
        version: "0.1.0",
      };
    `,
      { minCoreVersion: "0.2.0" },
    );

    const caps = await scanAddonsPath([TMP]);
    expect(caps[0]?.coreVersion).toBe(">=0.2.0");
  });

  test("an explicit coreVersion on the definition wins over package.json metadata", async () => {
    makeAddon(
      "test-group",
      "cap-explicit",
      `
      export default {
        name: "cap-explicit",
        label: "Explicit",
        type: "standard",
        category: "business",
        version: "0.1.0",
        coreVersion: ">=0.3.0",
      };
    `,
      { minCoreVersion: "^0.2.0" },
    );

    const caps = await scanAddonsPath([TMP]);
    expect(caps[0]?.coreVersion).toBe(">=0.3.0");
  });

  test("scanned coreVersion makes the boot check WARN (not throw) on VERSION skew", async () => {
    // The #122 trap: core VERSION "0.0.1" vs an addon's "^0.2.0" must surface a
    // warning at boot — never a throw — when strict mode is off (the default).
    makeAddon(
      "test-group",
      "cap-skew",
      `
      export default {
        name: "cap-skew",
        label: "Skew",
        type: "standard",
        category: "business",
        version: "0.1.0",
      };
    `,
      { minCoreVersion: "^0.2.0" },
    );

    const caps = await scanAddonsPath([TMP]);
    const warnings: string[] = [];
    const noop = () => {};

    expect(() =>
      enforceCoreCompatibility(caps, "0.0.1", {
        strict: false,
        logger: { debug: noop, info: noop, warn: (m) => warnings.push(m), error: noop },
      }),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cap-skew");
    expect(warnings[0]).toContain("^0.2.0");
  });
});
