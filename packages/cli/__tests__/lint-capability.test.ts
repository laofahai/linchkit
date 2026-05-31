import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintCapabilityCommand } from "../src/commands/lint-capability";

// -- Fixture helpers -----------------------------------------------------

const tmpRoots: string[] = [];

function makeCapDir(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-caplint-"));
  tmpRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

afterAll(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- Tests ---------------------------------------------------------------

describe("lint-capability command", () => {
  test("is wired with the expected meta and args", () => {
    expect(lintCapabilityCommand.meta).toMatchObject({ name: "lint-capability" });
    // citty exposes args on the resolved command definition.
    const args = lintCapabilityCommand.args as Record<string, { type: string }> | undefined;
    expect(args?.dir?.type).toBe("positional");
    expect(args?.json?.type).toBe("boolean");
  });

  test("CLI subprocess exits zero and reports ok for a clean capability", async () => {
    const root = makeCapDir();
    writeFile(
      root,
      "capability.json",
      JSON.stringify({
        name: "@linchkit/cap-cli-clean",
        version: "1.0.0",
        type: "standard",
        category: "business",
        label: "CLI Clean",
      }),
    );
    // package.json with peerDependencies is required by the core-version check (Spec 21 §10.1).
    writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "@linchkit/cap-cli-clean",
        version: "1.0.0",
        peerDependencies: { "@linchkit/core": "^0.2.0" },
        linchkit: { coreVersion: "^0.2.0" },
      }),
    );
    writeFile(root, "src/index.ts", `import { defineEntity } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/x.test.ts", `import { test } from "bun:test";\ntest("x", () => {});\n`);

    const cliEntry = join(import.meta.dir, "../src/index.ts");
    const proc = Bun.spawn(["bun", "run", cliEntry, "lint-capability", root, "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(proc.exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.dir).toBe(root);
  }, 15_000);

  test("CLI subprocess exits non-zero on a failing capability", async () => {
    const root = makeCapDir();
    // Missing manifest + bad import + no test → all three checks fail.
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core/src/engine/foo";\n`);

    const cliEntry = join(import.meta.dir, "../src/index.ts");
    const proc = Bun.spawn(["bun", "run", cliEntry, "lint-capability", root, "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    expect(proc.exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((i: { check: string }) => i.check === "metadata")).toBe(true);
    expect(parsed.issues.some((i: { check: string }) => i.check === "import-boundary")).toBe(true);
    expect(parsed.issues.some((i: { check: string }) => i.check === "test-existence")).toBe(true);
  }, 15_000);
});
