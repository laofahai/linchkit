import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../scripts/sync-core-version.ts");

const tmpRoots: string[] = [];

function makeFakeMonorepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-synccv-"));
  tmpRoots.push(root);
  return root;
}

function writeCapabilityPkg(root: string, addonPath: string, pkg: Record<string, unknown>): void {
  const dir = join(root, addonPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runScript(
  root: string,
  flags: string[] = [],
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, `--root=${root}`, ...flags], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

describe("sync-core-version script", () => {
  test("--check exits 0 when all coreVersions are in sync", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      linchkit: { coreVersion: "^0.3.0", type: "standard", category: "system" },
    });

    const { stdout, exit } = await runScript(root, ["--check"]);
    expect(exit).toBe(0);
    expect(stdout).toContain("in sync");
  });

  test("--check exits 1 and lists drifted packages when coreVersion lags peerDep", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      linchkit: { coreVersion: "^0.2.0", type: "standard", category: "system" },
    });

    const { stderr, exit } = await runScript(root, ["--check"]);
    expect(exit).toBe(1);
    expect(stderr).toContain("@linchkit/cap-auth");
    expect(stderr).toContain("drift");
  });

  test("sync mode updates linchkit.coreVersion to match peerDependencies", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      linchkit: { coreVersion: "^0.2.0", type: "standard", category: "system" },
    });

    const { stdout, exit } = await runScript(root);
    expect(exit).toBe(0);
    expect(stdout).toContain("Synced");
    expect(stdout).toContain("@linchkit/cap-auth");

    const updated = (await Bun.file(
      join(root, "addons/auth/cap-auth/package.json"),
    ).json()) as Record<string, unknown>;
    const linchkit = updated.linchkit as Record<string, unknown>;
    expect(linchkit.coreVersion).toBe("^0.3.0");
  });

  test("sync mode skips packages with workspace: peerDep (monorepo local)", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "workspace:*" },
      linchkit: { coreVersion: "^0.2.0", type: "standard", category: "system" },
    });

    const { stdout, exit } = await runScript(root);
    expect(exit).toBe(0);
    expect(stdout).toContain("already in sync");

    const unchanged = (await Bun.file(
      join(root, "addons/auth/cap-auth/package.json"),
    ).json()) as Record<string, unknown>;
    const linchkit = unchanged.linchkit as Record<string, unknown>;
    expect(linchkit.coreVersion).toBe("^0.2.0");
  });

  test("sync mode skips packages with no @linchkit/core peerDep", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { some: "^1.0.0" },
      linchkit: { coreVersion: "^0.2.0", type: "standard", category: "system" },
    });

    const { stdout, exit } = await runScript(root);
    expect(exit).toBe(0);
    expect(stdout).toContain("already in sync");
  });

  test("syncs multiple capabilities in one run", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      linchkit: { coreVersion: "^0.2.0", type: "standard", category: "system" },
    });
    writeCapabilityPkg(root, "addons/permission/cap-permission", {
      name: "@linchkit/cap-permission",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      linchkit: { coreVersion: "^0.2.0", type: "standard", category: "system" },
    });

    const { stdout, exit } = await runScript(root);
    expect(exit).toBe(0);
    expect(stdout).toContain("Synced 2 capability package(s)");

    for (const addonPath of ["addons/auth/cap-auth", "addons/permission/cap-permission"]) {
      const updated = (await Bun.file(join(root, addonPath, "package.json")).json()) as Record<
        string,
        unknown
      >;
      expect((updated.linchkit as Record<string, unknown>).coreVersion).toBe("^0.3.0");
    }
  });

  test("sync mode skips packages with no linchkit block (does not create one)", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      // intentionally no linchkit block
    });

    const { stdout, exit } = await runScript(root);
    expect(exit).toBe(0);
    expect(stdout).toContain("already in sync");

    const unchanged = (await Bun.file(
      join(root, "addons/auth/cap-auth/package.json"),
    ).json()) as Record<string, unknown>;
    expect(unchanged.linchkit).toBeUndefined();
  });

  test("--check exits 0 and does not report packages with no linchkit block", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      // intentionally no linchkit block
    });

    const { stdout, exit } = await runScript(root, ["--check"]);
    expect(exit).toBe(0);
    expect(stdout).toContain("in sync");
  });

  test("--check exits 1 and reports multiple drifted packages", async () => {
    const root = makeFakeMonorepo();
    writeCapabilityPkg(root, "addons/auth/cap-auth", {
      name: "@linchkit/cap-auth",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      linchkit: { coreVersion: "^0.2.0" },
    });
    writeCapabilityPkg(root, "addons/permission/cap-permission", {
      name: "@linchkit/cap-permission",
      version: "1.0.0",
      peerDependencies: { "@linchkit/core": "^0.3.0" },
      linchkit: { coreVersion: "^0.2.0" },
    });

    const { stderr, exit } = await runScript(root, ["--check"]);
    expect(exit).toBe(1);
    expect(stderr).toContain("2 capability package(s) have coreVersion drift");
  });
});
