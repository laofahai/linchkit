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

  test("runs the checker (JSON) and reports ok for a clean capability", () => {
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
    writeFile(root, "src/index.ts", `import { defineEntity } from "@linchkit/core";\nexport {};\n`);
    writeFile(root, "src/x.test.ts", `import { test } from "bun:test";\ntest("x", () => {});\n`);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      // run() prints JSON and does NOT call process.exit for a clean cap.
      // citty's run signature accepts a context object; we only need args here.
      // biome-ignore lint/suspicious/noExplicitAny: invoking citty handler directly in test
      (lintCapabilityCommand.run as any)({ args: { dir: root, json: true } });
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.dir).toBe(root);
  });

  test("CLI subprocess exits non-zero on a failing capability", async () => {
    const root = makeCapDir();
    // Missing manifest + bad import + no test → all three checks fail.
    writeFile(root, "src/index.ts", `import { x } from "@linchkit/core/src/engine/foo";\n`);

    const cliEntry = join(import.meta.dir, "../src/index.ts");
    const proc = Bun.spawn(["bun", "run", cliEntry, "lint-capability", root, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(proc.exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((i: { check: string }) => i.check === "metadata")).toBe(true);
    expect(parsed.issues.some((i: { check: string }) => i.check === "import-boundary")).toBe(true);
    expect(parsed.issues.some((i: { check: string }) => i.check === "test-existence")).toBe(true);
  }, 15_000);
});
