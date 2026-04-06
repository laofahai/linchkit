import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentsMdTemplate,
  claudeMdTemplate,
  envExampleTemplate,
  gitignoreTemplate,
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
    const result = linchkitConfigTemplate();
    expect(result).toContain("import { defineConfig } from '@linchkit/core'");
    expect(result).toContain("defineConfig({");
    expect(result).toContain("process.env.DATABASE_URL");
    expect(result).toContain("port: Number(process.env.PORT) || 3001");
    expect(result).toContain("capabilities: [],");
    // cap-auth appears only in a comment (as usage hint), not as an active import
    expect(result).toContain("// import { capAuth }");
    // No active (uncommented) import of cap-auth
    const lines = result.split("\n");
    const activeCapAuthImport = lines.some(
      (l: string) => l.includes("import { capAuth }") && !l.trimStart().startsWith("//"),
    );
    expect(activeCapAuthImport).toBe(false);
  });

  test("packageJsonTemplate generates valid package.json", () => {
    const result = packageJsonTemplate("my-project");
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("my-project");
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.dependencies["@linchkit/core"]).toBeDefined();
    expect(parsed.dependencies["@linchkit/cli"]).toBeDefined();
    expect(parsed.dependencies["@linchkit/cap-adapter-server"]).toBeDefined();
    // Should NOT depend on cap-auth or cap-permission
    expect(parsed.dependencies["@linchkit/cap-auth"]).toBeUndefined();
    expect(parsed.dependencies["@linchkit/cap-permission"]).toBeUndefined();
    expect(parsed.scripts.dev).toBe("linch dev");
    expect(parsed.scripts["dev:server"]).toBe("linch dev --server");
    expect(parsed.scripts["db:generate"]).toBe("linch db generate");
    expect(parsed.scripts["db:migrate"]).toBe("linch db migrate");
  });

  test("tsconfigTemplate generates valid tsconfig", () => {
    const result = tsconfigTemplate();
    const parsed = JSON.parse(result);
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.target).toBe("ES2022");
  });

  test("claudeMdTemplate includes project name and usage examples", () => {
    const result = claudeMdTemplate("test-project");
    expect(result).toContain("# test-project");
    expect(result).toContain("LinchKit");
    expect(result).toContain("defineEntity");
    expect(result).toContain("defineAction");
    expect(result).toContain("defineState");
    expect(result).toContain("defineCapability");
    expect(result).toContain("linch dev");
  });

  test("agentsMdTemplate includes project name and comprehensive reference", () => {
    const result = agentsMdTemplate("test-project");
    expect(result).toContain("# test-project");
    expect(result).toContain("defineEntity()");
    expect(result).toContain("defineAction()");
    expect(result).toContain("defineState()");
    expect(result).toContain("defineRelation()");
    expect(result).toContain("Field Types Reference");
    expect(result).toContain("Action Types");
  });

  test("envExampleTemplate generates env file", () => {
    const result = envExampleTemplate();
    expect(result).toContain("DATABASE_URL");
    expect(result).toContain("PORT=3001");
  });

  test("gitignoreTemplate generates gitignore", () => {
    const result = gitignoreTemplate();
    expect(result).toContain("node_modules/");
    expect(result).toContain(".env");
    expect(result).toContain(".linchkit/");
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
    expect(existsSync(resolve(projectDir, "tests/.gitkeep"))).toBe(true);
    expect(existsSync(resolve(projectDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(resolve(projectDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(resolve(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(resolve(projectDir, ".env"))).toBe(true);
    expect(existsSync(resolve(projectDir, ".gitignore"))).toBe(true);

    // Verify file contents
    const configContent = readFileSync(resolve(projectDir, "linchkit.config.ts"), "utf-8");
    expect(configContent).toContain("defineConfig");
    // cap-auth only in commented example, not as active import
    expect(configContent).toContain("// import { capAuth }");

    const pkgContent = readFileSync(resolve(projectDir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgContent);
    expect(pkg.name).toBe(projectName);

    const tsconfigContent = readFileSync(resolve(projectDir, "tsconfig.json"), "utf-8");
    const tsconfig = JSON.parse(tsconfigContent);
    expect(tsconfig.compilerOptions.strict).toBe(true);

    // Verify no migrations directory (removed — drizzle generates it)
    expect(existsSync(resolve(projectDir, "migrations/.gitkeep"))).toBe(false);
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
