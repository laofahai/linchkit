import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentsMdTemplate,
  claudeMdTemplate,
  linchkitConfigTemplate,
  packageJsonTemplate,
  tsconfigTemplate,
} from "../src/templates";

const TEST_DIR = resolve(import.meta.dir, ".tmp-test-projects");

function cleanup(dir: string) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("templates", () => {
  test("linchkitConfigTemplate generates valid config", () => {
    const result = linchkitConfigTemplate("my_project");
    expect(result).toContain("import { defineConfig } from '@linchkit/core'");
    expect(result).toContain("defineConfig({");
    expect(result).toContain("postgres://localhost:5432/my_project");
    expect(result).toContain("port: 3000");
  });

  test("packageJsonTemplate generates valid package.json", () => {
    const result = packageJsonTemplate("my-project");
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("my-project");
    expect(parsed.dependencies["@linchkit/core"]).toBeDefined();
    expect(parsed.dependencies["@linchkit/cli"]).toBeDefined();
    expect(parsed.scripts.dev).toBe("linch dev");
  });

  test("tsconfigTemplate generates valid tsconfig", () => {
    const result = tsconfigTemplate();
    const parsed = JSON.parse(result);
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.target).toBe("ES2022");
  });

  test("claudeMdTemplate includes project name", () => {
    const result = claudeMdTemplate("test-project");
    expect(result).toContain("# test-project");
    expect(result).toContain("LinchKit");
  });

  test("agentsMdTemplate includes project name", () => {
    const result = agentsMdTemplate("test-project");
    expect(result).toContain("# test-project");
    expect(result).toContain("defineEntity()");
  });
});

describe("linch init (integration)", () => {
  const projectName = "test-init-project";
  const projectDir = resolve(TEST_DIR, projectName);

  afterEach(() => {
    cleanup(TEST_DIR);
  });

  test("creates project directory structure", async () => {
    // Ensure test directory exists before running command
    mkdirSync(TEST_DIR, { recursive: true });

    const proc = Bun.spawn(
      ["bun", "run", resolve(import.meta.dir, "../src/index.ts"), "init", projectName],
      {
        cwd: TEST_DIR,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    await proc.exited;

    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("Project created successfully!");

    // Verify directory structure
    expect(existsSync(resolve(projectDir, "linchkit.config.ts"))).toBe(true);
    expect(existsSync(resolve(projectDir, "package.json"))).toBe(true);
    expect(existsSync(resolve(projectDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(resolve(projectDir, "addons/.gitkeep"))).toBe(true);
    expect(existsSync(resolve(projectDir, "migrations/.gitkeep"))).toBe(true);
    expect(existsSync(resolve(projectDir, "tests/.gitkeep"))).toBe(true);
    expect(existsSync(resolve(projectDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(true);

    // Verify file contents
    const configContent = readFileSync(resolve(projectDir, "linchkit.config.ts"), "utf-8");
    expect(configContent).toContain("defineConfig");

    const pkgContent = readFileSync(resolve(projectDir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgContent);
    expect(pkg.name).toBe(projectName);

    const tsconfigContent = readFileSync(resolve(projectDir, "tsconfig.json"), "utf-8");
    const tsconfig = JSON.parse(tsconfigContent);
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  test("fails if directory already exists", async () => {
    mkdirSync(projectDir, { recursive: true });

    const proc = Bun.spawn(
      ["bun", "run", resolve(import.meta.dir, "../src/index.ts"), "init", projectName],
      {
        cwd: TEST_DIR,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    await proc.exited;

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("already exists");
  });
});
