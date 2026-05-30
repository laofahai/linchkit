import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAddonsPath } from "../../src/capability/addon-scanner";

/**
 * Spec 21 §7.2: the boot-time scanner reads the standalone `capability.json`
 * manifest with HIGHER precedence than `package.json`. These tests build real
 * fixture directories on disk because the scanner uses dynamic `await import()`.
 */

const ROOTS: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "addon-scan-manifest-"));
  ROOTS.push(root);
  return root;
}

interface FixtureOptions {
  /** Package name written to package.json (drives trust inference). */
  packageName?: string;
  /** package.json `linchkit` block. */
  pkgLinchkit?: Record<string, unknown>;
  /** capability.json contents. When `false`, no capability.json is written. */
  capabilityJson?: Record<string, unknown> | false;
  /** Raw capability.json text (overrides `capabilityJson`, for malformed JSON). */
  capabilityJsonRaw?: string;
  /** Extra fields merged into the default-exported CapabilityDefinition. */
  defExtra?: Record<string, unknown>;
}

/**
 * Create `{root}/{group}/cap-foo/` with a package.json, a tiny src/index.ts that
 * default-exports a minimal CapabilityDefinition, and optionally a capability.json.
 */
function makeAddon(root: string, options: FixtureOptions = {}): void {
  const {
    packageName = "@linchkit/cap-foo",
    pkgLinchkit,
    capabilityJson,
    capabilityJsonRaw,
    defExtra = {},
  } = options;

  const capDir = join(root, "test-group", "cap-foo");
  mkdirSync(join(capDir, "src"), { recursive: true });

  const pkg: Record<string, unknown> = { name: packageName, main: "src/index.ts" };
  if (pkgLinchkit) pkg.linchkit = pkgLinchkit;
  writeFileSync(join(capDir, "package.json"), JSON.stringify(pkg));

  const def = {
    name: "cap-foo",
    label: "Foo",
    type: "standard",
    category: "business",
    version: "0.1.0",
    ...defExtra,
  };
  writeFileSync(join(capDir, "src", "index.ts"), `export default ${JSON.stringify(def)};`);

  if (capabilityJsonRaw !== undefined) {
    writeFileSync(join(capDir, "capability.json"), capabilityJsonRaw);
  } else if (capabilityJson !== false && capabilityJson !== undefined) {
    writeFileSync(join(capDir, "capability.json"), JSON.stringify(capabilityJson));
  }
}

/** A schema-valid capability.json payload with the given overrides applied. */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "@linchkit/cap-foo",
    version: "0.1.0",
    type: "standard",
    category: "business",
    label: "Foo",
    ...overrides,
  };
}

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

describe("scanAddonsPath — capability.json precedence (Spec 21 §7.2)", () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  test("capability.json coreVersion overrides package.json coreVersion", async () => {
    makeAddon(root, {
      pkgLinchkit: { coreVersion: "^0.2.0" },
      capabilityJson: validManifest({ linchkit: { coreVersion: ">=0.3.0" } }),
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.coreVersion).toBe(">=0.3.0");
  });

  test("falls back to package.json linchkit when no capability.json is present", async () => {
    makeAddon(root, {
      pkgLinchkit: { minCoreVersion: "^0.2.0" },
      capabilityJson: false,
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.coreVersion).toBe("^0.2.0");
  });

  test("an explicit coreVersion on the code definition wins over both manifests", async () => {
    makeAddon(root, {
      defExtra: { coreVersion: ">=0.5.0" },
      pkgLinchkit: { coreVersion: "^0.2.0" },
      capabilityJson: validManifest({ linchkit: { coreVersion: ">=0.3.0" } }),
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.coreVersion).toBe(">=0.5.0");
  });

  test("a declared trustLevel is CLAMPED against the name-justified tier (anti-spoof)", async () => {
    // `linchkit-cap-foo` infers `community`; declaring `official` must clamp
    // back DOWN to `community` — a self-declaration can never raise standing.
    makeAddon(root, {
      packageName: "linchkit-cap-foo",
      capabilityJson: {
        name: "linchkit-cap-foo",
        version: "0.1.0",
        type: "standard",
        category: "business",
        label: "Foo",
        trustLevel: "official",
      },
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.trustLevel).toBe("community");
    expect(caps[0]?.trustLevel).not.toBe("official");
  });

  test("a trustLevel hardcoded on the code export is CLAMPED (anti-spoof regression)", async () => {
    // SECURITY: a malicious addon ships `trustLevel: "official"` directly on its
    // code export (src/index.ts default), with NO capability.json declaring trust.
    // `linchkit-cap-foo` only justifies `community`, so the spoofed tier must be
    // clamped DOWN to `community` — the clamp must NOT be skipped just because the
    // tier was declared on the code-def rather than a manifest.
    makeAddon(root, {
      packageName: "linchkit-cap-foo",
      capabilityJson: false,
      defExtra: { trustLevel: "official" },
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.trustLevel).toBe("community");
    expect(caps[0]?.trustLevel).not.toBe("official");
  });

  test("package.json linchkit.trustLevel is used as a fallback AND clamped", async () => {
    // No capability.json and no code-def trustLevel — the declared tier comes
    // from package.json's `linchkit` block (§7.2 lowest-precedence fallback) and
    // is still clamped: `linchkit-cap-bar` justifies only `community`.
    makeAddon(root, {
      packageName: "linchkit-cap-bar",
      pkgLinchkit: { trustLevel: "official" },
      capabilityJson: false,
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.trustLevel).toBe("community");
    expect(caps[0]?.trustLevel).not.toBe("official");
  });

  test("an invalid code-declared trustLevel is dropped (not promoted)", async () => {
    // SECURITY: a malicious JS addon hardcodes an UNKNOWN tier ("superadmin") on
    // its code export. That string has no rank in TRUST_LEVEL_ORDER, so it must be
    // rejected by the trustLevelEnum guard BEFORE clamping — the result is an
    // ignored declaration (`undefined`), never the invalid string and never a
    // silent promotion to `official`. The `as` cast simulates the untyped value a
    // hand-written addon could inject past the type system.
    makeAddon(root, {
      packageName: "@linchkit/cap-x",
      capabilityJson: false,
      defExtra: { trustLevel: "superadmin" as unknown as string },
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.trustLevel).toBeUndefined();
  });

  test("an invalid package.json linchkit.trustLevel is ignored", async () => {
    // The lowest-precedence declared source (package.json `linchkit`) carries an
    // unknown tier ("root"). With no capability.json and no code-def tier, the
    // guard rejects it and `trustLevel` is left undefined.
    makeAddon(root, {
      packageName: "linchkit-cap-y",
      pkgLinchkit: { trustLevel: "root" },
      capabilityJson: false,
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.trustLevel).toBeUndefined();
  });

  test("a legitimately official code-declared tier is preserved", async () => {
    // `@linchkit/cap-baz` justifies `official`, so a code-def declaring `official`
    // is honored unchanged — the clamp ceiling equals the declared tier.
    makeAddon(root, {
      packageName: "@linchkit/cap-baz",
      capabilityJson: false,
      defExtra: { trustLevel: "official" },
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.trustLevel).toBe("official");
  });

  test("copies dependencies from capability.json when the code-def omits them", async () => {
    makeAddon(root, {
      capabilityJson: validManifest({ dependencies: ["@linchkit/cap-auth"] }),
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.dependencies).toEqual(["@linchkit/cap-auth"]);
  });

  test("malformed capability.json (invalid JSON) does not drop the addon", async () => {
    makeAddon(root, {
      pkgLinchkit: { coreVersion: "^0.2.0" },
      capabilityJsonRaw: "{ this is not valid json",
    });

    const caps = await scanAddonsPath([root]);
    // Addon still loaded; coreVersion falls back to package.json; no throw.
    expect(caps).toHaveLength(1);
    expect(caps[0]?.name).toBe("cap-foo");
    expect(caps[0]?.coreVersion).toBe("^0.2.0");
  });

  test("schema-invalid capability.json does not drop the addon", async () => {
    makeAddon(root, {
      pkgLinchkit: { coreVersion: "^0.2.0" },
      // Missing required fields (type/category/version) → fails validation.
      capabilityJson: { name: "@linchkit/cap-foo", label: "Foo" },
    });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.name).toBe("cap-foo");
    expect(caps[0]?.coreVersion).toBe("^0.2.0");
  });

  test("regression: capability with neither manifest leaves coreVersion/trustLevel undefined", async () => {
    makeAddon(root, { capabilityJson: false });

    const caps = await scanAddonsPath([root]);
    expect(caps).toHaveLength(1);
    expect(caps[0]?.coreVersion).toBeUndefined();
    expect(caps[0]?.trustLevel).toBeUndefined();
    expect(caps[0]?.dependencies).toBeUndefined();
  });
});
