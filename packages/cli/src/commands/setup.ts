/**
 * linch setup — Sync AI tool configurations for the current project.
 *
 * Idempotent: safe to run repeatedly. Regenerates framework-managed files
 * (skills, MCP config) without touching user-customizable content
 * (AGENTS.user.md, hand-written CLAUDE.md sections).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
  codexMdTemplate,
  copilotInstructionsTemplate,
  cursorRulesTemplate,
  linchkitSkills,
  mcpJsonTemplate,
  traeRulesTemplate,
} from "../templates";

export const ALL_AI_TOOLS = ["claude-code", "cursor", "codex", "trae", "copilot"] as const;
export type AiTool = (typeof ALL_AI_TOOLS)[number];

/** Detect which AI tools are already configured in the project */
export function detectAiTools(projectDir: string): AiTool[] {
  const detected: AiTool[] = [];
  if (existsSync(resolve(projectDir, ".claude"))) detected.push("claude-code");
  if (existsSync(resolve(projectDir, ".cursor"))) detected.push("cursor");
  if (existsSync(resolve(projectDir, "codex.md"))) detected.push("codex");
  if (existsSync(resolve(projectDir, ".trae"))) detected.push("trae");
  if (existsSync(resolve(projectDir, ".github/copilot-instructions.md"))) detected.push("copilot");
  return detected;
}

export interface SetupOptions {
  projectDir: string;
  projectName: string;
  tools: AiTool[];
  /** When true, always write MCP config even if it exists (used by init) */
  force?: boolean;
}

/**
 * Sync AI tool configurations into a project directory.
 * Shared by both `linch init` and `linch setup`.
 *
 * Returns the list of files that were written/updated.
 */
export function syncAiToolConfigs(opts: SetupOptions): string[] {
  const { projectDir, projectName, tools, force } = opts;
  const updated: string[] = [];
  const skills = linchkitSkills();

  // --- Claude Code ---
  if (tools.includes("claude-code")) {
    // Claude Code expects: .claude/skills/<slug>/SKILL.md
    for (const skill of skills) {
      const skillDir = resolve(projectDir, `.claude/skills/${skill.slug}`);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), skill.content);
    }
    updated.push(`.claude/skills/ (${skills.length} skills)`);

    const mcpPath = resolve(projectDir, ".mcp.json");
    if (force || !existsSync(mcpPath)) {
      writeFileSync(mcpPath, mcpJsonTemplate());
      updated.push(".mcp.json");
    }
  }

  // --- Cursor ---
  if (tools.includes("cursor")) {
    const skillDir = resolve(projectDir, ".cursor/rules/linch");
    mkdirSync(skillDir, { recursive: true });
    for (const skill of skills) {
      writeFileSync(resolve(skillDir, skill.filename), skill.content);
    }
    writeFileSync(
      resolve(projectDir, ".cursor/rules/linchkit.md"),
      cursorRulesTemplate(projectName),
    );
    updated.push(`.cursor/rules/linch/ (${skills.length} skills)`, ".cursor/rules/linchkit.md");

    const cursorMcpPath = resolve(projectDir, ".cursor/mcp.json");
    if (force || !existsSync(cursorMcpPath)) {
      writeFileSync(cursorMcpPath, mcpJsonTemplate());
      updated.push(".cursor/mcp.json");
    }
  }

  // --- Codex ---
  if (tools.includes("codex")) {
    writeFileSync(resolve(projectDir, "codex.md"), codexMdTemplate());
    updated.push("codex.md");
  }

  // --- Trae ---
  if (tools.includes("trae")) {
    const skillDir = resolve(projectDir, ".trae/rules/linch");
    mkdirSync(skillDir, { recursive: true });
    for (const skill of skills) {
      writeFileSync(resolve(skillDir, skill.filename), skill.content);
    }
    writeFileSync(resolve(projectDir, ".trae/rules/linchkit.md"), traeRulesTemplate(projectName));
    updated.push(`.trae/rules/linch/ (${skills.length} skills)`, ".trae/rules/linchkit.md");
  }

  // --- Copilot ---
  if (tools.includes("copilot")) {
    mkdirSync(resolve(projectDir, ".github"), { recursive: true });
    writeFileSync(
      resolve(projectDir, ".github/copilot-instructions.md"),
      copilotInstructionsTemplate(projectName),
    );
    updated.push(".github/copilot-instructions.md");
  }

  return updated;
}

export const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description:
      "Sync AI tool configurations (skills, MCP, agent instructions) for the current project",
  },
  args: {
    "ai-tools": {
      type: "string",
      description:
        "Comma-separated AI tools to configure (claude-code,cursor,codex,trae,copilot). Auto-detects if omitted.",
    },
    all: {
      type: "boolean",
      description: "Configure all supported AI tools, not just detected ones",
      default: false,
    },
  },
  run({ args }) {
    const projectDir = process.cwd();
    const projectName = resolve(projectDir).split("/").pop() ?? "project";

    // Determine which AI tools to configure
    let selectedTools: AiTool[];
    if (args["ai-tools"]) {
      selectedTools = args["ai-tools"].split(",").map((t: string) => t.trim()) as AiTool[];
    } else if (args.all) {
      selectedTools = [...ALL_AI_TOOLS];
    } else {
      selectedTools = detectAiTools(projectDir);
      if (selectedTools.length === 0) {
        console.log("No AI tools detected. Use --ai-tools or --all to specify which to configure.");
        console.log(`  Supported: ${ALL_AI_TOOLS.join(", ")}`);
        return;
      }
    }

    const updated = syncAiToolConfigs({
      projectDir,
      projectName,
      tools: selectedTools,
    });

    console.log("");
    console.log(`[linch] AI tool configurations synced for: ${selectedTools.join(", ")}`);
    console.log("");
    if (updated.length > 0) {
      console.log("  Updated:");
      for (const f of updated) {
        console.log(`    • ${f}`);
      }
    }
    console.log("");
    console.log("  Tip: Run this command after upgrading LinchKit to sync latest skills.");
    console.log("  Tip: Run 'linch agents-md' to regenerate AGENTS.md from project ontology.");
    console.log("");
  },
});
