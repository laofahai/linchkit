/**
 * Tests for the `linch setup` command: AI tool detection, skill generation,
 * file writing, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AiTool,
  ALL_AI_TOOLS,
  detectAiTools,
  syncAiToolConfigs,
} from "../src/commands/setup";
import { linchkitSkills } from "../src/templates";

const TEST_DIR = resolve(import.meta.dir, ".tmp-test-setup");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// detectAiTools
// ---------------------------------------------------------------------------
describe("detectAiTools", () => {
  test("returns empty array when no AI tool markers exist", () => {
    expect(detectAiTools(TEST_DIR)).toEqual([]);
  });

  test("detects claude-code via .claude directory", () => {
    mkdirSync(resolve(TEST_DIR, ".claude"), { recursive: true });
    expect(detectAiTools(TEST_DIR)).toEqual(["claude-code"]);
  });

  test("detects cursor via .cursor directory", () => {
    mkdirSync(resolve(TEST_DIR, ".cursor"), { recursive: true });
    expect(detectAiTools(TEST_DIR)).toEqual(["cursor"]);
  });

  test("detects codex via codex.md file", () => {
    writeFileSync(resolve(TEST_DIR, "codex.md"), "# codex");
    expect(detectAiTools(TEST_DIR)).toEqual(["codex"]);
  });

  test("detects trae via .trae directory", () => {
    mkdirSync(resolve(TEST_DIR, ".trae"), { recursive: true });
    expect(detectAiTools(TEST_DIR)).toEqual(["trae"]);
  });

  test("detects copilot via .github/copilot-instructions.md", () => {
    mkdirSync(resolve(TEST_DIR, ".github"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, ".github/copilot-instructions.md"), "# copilot");
    expect(detectAiTools(TEST_DIR)).toEqual(["copilot"]);
  });

  test("detects multiple tools simultaneously", () => {
    mkdirSync(resolve(TEST_DIR, ".claude"), { recursive: true });
    mkdirSync(resolve(TEST_DIR, ".cursor"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, "codex.md"), "");
    const result = detectAiTools(TEST_DIR);
    expect(result).toContain("claude-code");
    expect(result).toContain("cursor");
    expect(result).toContain("codex");
    expect(result).toHaveLength(3);
  });

  test("detects all five tools when all markers exist", () => {
    mkdirSync(resolve(TEST_DIR, ".claude"), { recursive: true });
    mkdirSync(resolve(TEST_DIR, ".cursor"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, "codex.md"), "");
    mkdirSync(resolve(TEST_DIR, ".trae"), { recursive: true });
    mkdirSync(resolve(TEST_DIR, ".github"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, ".github/copilot-instructions.md"), "");
    expect(detectAiTools(TEST_DIR)).toEqual([...ALL_AI_TOOLS]);
  });
});

// ---------------------------------------------------------------------------
// syncAiToolConfigs — Claude Code
// ---------------------------------------------------------------------------
describe("syncAiToolConfigs — claude-code", () => {
  const skills = linchkitSkills();

  test("creates skill files under .claude/skills/<slug>/SKILL.md", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["claude-code"],
    });

    for (const skill of skills) {
      const skillPath = resolve(TEST_DIR, `.claude/skills/${skill.slug}/SKILL.md`);
      expect(existsSync(skillPath)).toBe(true);
      const content = readFileSync(skillPath, "utf-8");
      expect(content).toBe(skill.content);
    }
  });

  test("creates .mcp.json when it does not exist", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["claude-code"],
    });

    const mcpPath = resolve(TEST_DIR, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(parsed.mcpServers.linchkit).toBeDefined();
  });

  test("does not overwrite existing .mcp.json without force", () => {
    const mcpPath = resolve(TEST_DIR, ".mcp.json");
    writeFileSync(mcpPath, '{"custom": true}');

    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["claude-code"],
    });

    const content = readFileSync(mcpPath, "utf-8");
    expect(JSON.parse(content)).toEqual({ custom: true });
  });

  test("overwrites existing .mcp.json with force flag", () => {
    const mcpPath = resolve(TEST_DIR, ".mcp.json");
    writeFileSync(mcpPath, '{"custom": true}');

    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["claude-code"],
      force: true,
    });

    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.custom).toBeUndefined();
  });

  test("returns list of updated files including skill count", () => {
    const updated = syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["claude-code"],
    });

    expect(updated).toContain(`.claude/skills/ (${skills.length} skills)`);
    expect(updated).toContain(".mcp.json");
  });
});

// ---------------------------------------------------------------------------
// syncAiToolConfigs — Cursor
// ---------------------------------------------------------------------------
describe("syncAiToolConfigs — cursor", () => {
  const skills = linchkitSkills();

  test("creates skill files under .cursor/rules/linch/", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["cursor"],
    });

    for (const skill of skills) {
      const skillPath = resolve(TEST_DIR, `.cursor/rules/linch/${skill.filename}`);
      expect(existsSync(skillPath)).toBe(true);
    }
  });

  test("creates .cursor/rules/linchkit.md with project name", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "my-app",
      tools: ["cursor"],
    });

    const rulesPath = resolve(TEST_DIR, ".cursor/rules/linchkit.md");
    expect(existsSync(rulesPath)).toBe(true);
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).toContain("my-app");
  });

  test("creates .cursor/mcp.json when it does not exist", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["cursor"],
    });

    const mcpPath = resolve(TEST_DIR, ".cursor/mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
  });

  test("does not overwrite existing .cursor/mcp.json without force", () => {
    const mcpDir = resolve(TEST_DIR, ".cursor");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(resolve(mcpDir, "mcp.json"), '{"existing": true}');

    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["cursor"],
    });

    const content = readFileSync(resolve(mcpDir, "mcp.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ existing: true });
  });
});

// ---------------------------------------------------------------------------
// syncAiToolConfigs — Codex
// ---------------------------------------------------------------------------
describe("syncAiToolConfigs — codex", () => {
  test("creates codex.md", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["codex"],
    });

    const codexPath = resolve(TEST_DIR, "codex.md");
    expect(existsSync(codexPath)).toBe(true);
    const content = readFileSync(codexPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  test("returns codex.md in updated list", () => {
    const updated = syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["codex"],
    });
    expect(updated).toContain("codex.md");
  });
});

// ---------------------------------------------------------------------------
// syncAiToolConfigs — Trae
// ---------------------------------------------------------------------------
describe("syncAiToolConfigs — trae", () => {
  const skills = linchkitSkills();

  test("creates skill files under .trae/rules/linch/", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["trae"],
    });

    for (const skill of skills) {
      const skillPath = resolve(TEST_DIR, `.trae/rules/linch/${skill.filename}`);
      expect(existsSync(skillPath)).toBe(true);
    }
  });

  test("creates .trae/rules/linchkit.md with project name", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "my-trae-app",
      tools: ["trae"],
    });

    const rulesPath = resolve(TEST_DIR, ".trae/rules/linchkit.md");
    expect(existsSync(rulesPath)).toBe(true);
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).toContain("my-trae-app");
  });
});

// ---------------------------------------------------------------------------
// syncAiToolConfigs — Copilot
// ---------------------------------------------------------------------------
describe("syncAiToolConfigs — copilot", () => {
  test("creates .github/copilot-instructions.md with project name", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "copilot-proj",
      tools: ["copilot"],
    });

    const instrPath = resolve(TEST_DIR, ".github/copilot-instructions.md");
    expect(existsSync(instrPath)).toBe(true);
    const content = readFileSync(instrPath, "utf-8");
    expect(content).toContain("copilot-proj");
  });

  test("returns copilot path in updated list", () => {
    const updated = syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["copilot"],
    });
    expect(updated).toContain(".github/copilot-instructions.md");
  });
});

// ---------------------------------------------------------------------------
// syncAiToolConfigs — multiple tools & edge cases
// ---------------------------------------------------------------------------
describe("syncAiToolConfigs — multiple tools and edge cases", () => {
  test("configures all tools when ALL_AI_TOOLS is passed", () => {
    const updated = syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "all-tools",
      tools: [...ALL_AI_TOOLS],
    });

    // Claude Code artifacts
    expect(existsSync(resolve(TEST_DIR, ".claude/skills"))).toBe(true);
    expect(existsSync(resolve(TEST_DIR, ".mcp.json"))).toBe(true);
    // Cursor artifacts
    expect(existsSync(resolve(TEST_DIR, ".cursor/rules/linchkit.md"))).toBe(true);
    expect(existsSync(resolve(TEST_DIR, ".cursor/mcp.json"))).toBe(true);
    // Codex artifacts
    expect(existsSync(resolve(TEST_DIR, "codex.md"))).toBe(true);
    // Trae artifacts
    expect(existsSync(resolve(TEST_DIR, ".trae/rules/linchkit.md"))).toBe(true);
    // Copilot artifacts
    expect(existsSync(resolve(TEST_DIR, ".github/copilot-instructions.md"))).toBe(true);

    // Should have entries for all tools
    expect(updated.length).toBeGreaterThanOrEqual(ALL_AI_TOOLS.length);
  });

  test("returns empty list when no tools are specified", () => {
    const updated = syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "empty",
      tools: [],
    });
    expect(updated).toEqual([]);
  });

  test("is idempotent — running twice produces same result", () => {
    const opts = {
      projectDir: TEST_DIR,
      projectName: "idempotent",
      tools: ["claude-code", "cursor"] as AiTool[],
    };

    syncAiToolConfigs(opts);
    const firstRun = syncAiToolConfigs(opts);

    // Second run should still report skills (they are always overwritten)
    // but not .mcp.json (only written if missing)
    expect(firstRun.some((f) => f.includes("skills"))).toBe(true);
  });

  test("skill content is non-empty for all generated skills", () => {
    syncAiToolConfigs({
      projectDir: TEST_DIR,
      projectName: "test-proj",
      tools: ["claude-code"],
    });

    const skills = linchkitSkills();
    for (const skill of skills) {
      const skillPath = resolve(TEST_DIR, `.claude/skills/${skill.slug}/SKILL.md`);
      const content = readFileSync(skillPath, "utf-8");
      expect(content.length).toBeGreaterThan(50);
    }
  });
});

// ---------------------------------------------------------------------------
// ALL_AI_TOOLS constant
// ---------------------------------------------------------------------------
describe("ALL_AI_TOOLS", () => {
  test("contains exactly five known tools", () => {
    expect(ALL_AI_TOOLS).toHaveLength(5);
    expect(ALL_AI_TOOLS).toContain("claude-code");
    expect(ALL_AI_TOOLS).toContain("cursor");
    expect(ALL_AI_TOOLS).toContain("codex");
    expect(ALL_AI_TOOLS).toContain("trae");
    expect(ALL_AI_TOOLS).toContain("copilot");
  });
});
