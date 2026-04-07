/**
 * linch init [project-name] — Scaffold a new LinchKit project
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
  agentsMdTemplate,
  agentsUserMdTemplate,
  claudeMdTemplate,
  codexMdTemplate,
  copilotInstructionsTemplate,
  cursorRulesTemplate,
  envExampleTemplate,
  gitignoreTemplate,
  linchkitConfigTemplate,
  linchkitSkills,
  mcpJsonTemplate,
  packageJsonTemplate,
  traeRulesTemplate,
  tsconfigTemplate,
} from "../templates";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold a new LinchKit project",
  },
  args: {
    name: {
      type: "positional",
      description: "Project name",
      default: "my-linchkit-project",
    },
    "ai-tools": {
      type: "string",
      description:
        "Comma-separated AI tools to configure (claude-code,cursor,codex,trae,copilot). Defaults to all.",
    },
  },
  run({ args }) {
    const projectName = args.name;
    const projectDir = resolve(process.cwd(), projectName);

    const allTools = ["claude-code", "cursor", "codex", "trae", "copilot"] as const;
    type AiTool = (typeof allTools)[number];
    const selectedTools: AiTool[] = args["ai-tools"]
      ? (args["ai-tools"].split(",").map((t: string) => t.trim()) as AiTool[])
      : [...allTools];

    if (existsSync(projectDir)) {
      console.error(`Error: Directory "${projectName}" already exists.`);
      process.exit(1);
    }

    console.log(`Creating LinchKit project: ${projectName}`);

    // Create directory structure
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(resolve(projectDir, "addons"), { recursive: true });
    mkdirSync(resolve(projectDir, "tests"), { recursive: true });

    // Write .gitkeep files
    writeFileSync(resolve(projectDir, "addons/.gitkeep"), "");
    writeFileSync(resolve(projectDir, "tests/.gitkeep"), "");

    // Write config and project files
    writeFileSync(resolve(projectDir, "linchkit.config.ts"), linchkitConfigTemplate());
    writeFileSync(resolve(projectDir, "package.json"), packageJsonTemplate(projectName));
    writeFileSync(resolve(projectDir, "tsconfig.json"), tsconfigTemplate());
    writeFileSync(resolve(projectDir, "CLAUDE.md"), claudeMdTemplate(projectName));
    writeFileSync(resolve(projectDir, "AGENTS.md"), agentsMdTemplate(projectName));

    // Write env and gitignore files
    writeFileSync(resolve(projectDir, ".env.example"), envExampleTemplate());
    writeFileSync(resolve(projectDir, ".env"), envExampleTemplate());
    writeFileSync(resolve(projectDir, ".gitignore"), gitignoreTemplate());

    // Write user-customizable agent instructions
    writeFileSync(resolve(projectDir, "AGENTS.user.md"), agentsUserMdTemplate(projectName));

    // Generate AI tool configurations and skill files
    const skills = linchkitSkills();
    const generatedAiFiles: string[] = [];

    if (selectedTools.includes("claude-code")) {
      writeFileSync(resolve(projectDir, ".mcp.json"), mcpJsonTemplate());
      mkdirSync(resolve(projectDir, ".claude/skills/linch"), { recursive: true });
      for (const skill of skills) {
        writeFileSync(resolve(projectDir, `.claude/skills/linch/${skill.filename}`), skill.content);
      }
      generatedAiFiles.push(".mcp.json", `.claude/skills/linch/ (${skills.length} skills)`);
    }

    if (selectedTools.includes("cursor")) {
      mkdirSync(resolve(projectDir, ".cursor/rules/linch"), { recursive: true });
      writeFileSync(
        resolve(projectDir, ".cursor/rules/linchkit.md"),
        cursorRulesTemplate(projectName),
      );
      writeFileSync(resolve(projectDir, ".cursor/mcp.json"), mcpJsonTemplate());
      for (const skill of skills) {
        writeFileSync(resolve(projectDir, `.cursor/rules/linch/${skill.filename}`), skill.content);
      }
      generatedAiFiles.push(
        ".cursor/rules/linchkit.md",
        ".cursor/mcp.json",
        `.cursor/rules/linch/ (${skills.length} skills)`,
      );
    }

    if (selectedTools.includes("codex")) {
      writeFileSync(resolve(projectDir, "codex.md"), codexMdTemplate());
      generatedAiFiles.push("codex.md");
    }

    if (selectedTools.includes("trae")) {
      mkdirSync(resolve(projectDir, ".trae/rules/linch"), { recursive: true });
      writeFileSync(resolve(projectDir, ".trae/rules/linchkit.md"), traeRulesTemplate(projectName));
      for (const skill of skills) {
        writeFileSync(resolve(projectDir, `.trae/rules/linch/${skill.filename}`), skill.content);
      }
      generatedAiFiles.push(
        ".trae/rules/linchkit.md",
        `.trae/rules/linch/ (${skills.length} skills)`,
      );
    }

    if (selectedTools.includes("copilot")) {
      mkdirSync(resolve(projectDir, ".github"), { recursive: true });
      writeFileSync(
        resolve(projectDir, ".github/copilot-instructions.md"),
        copilotInstructionsTemplate(projectName),
      );
      generatedAiFiles.push(".github/copilot-instructions.md");
    }

    console.log("");
    console.log("Project created successfully!");
    console.log("");
    console.log("  Project structure:");
    console.log(`  ${projectName}/`);
    console.log("    ├── linchkit.config.ts");
    console.log("    ├── package.json");
    console.log("    ├── tsconfig.json");
    console.log("    ├── .env.example");
    console.log("    ├── .env");
    console.log("    ├── .gitignore");
    console.log("    ├── addons/");
    console.log("    ├── tests/");
    console.log("    ├── CLAUDE.md");
    console.log("    ├── AGENTS.md");
    console.log("    └── AGENTS.user.md");
    if (generatedAiFiles.length > 0) {
      console.log("");
      console.log("  AI tool configs:");
      for (const f of generatedAiFiles) {
        console.log(`    • ${f}`);
      }
    }
    console.log("");
    console.log("  Next steps:");
    console.log(`    cd ${projectName}`);
    console.log("    bun install");
    console.log("    linch dev");
    console.log("");
    console.log("  AI-guided setup:");
    console.log("    Open this project in your AI coding tool and paste:");
    console.log("");
    if (selectedTools.includes("claude-code")) {
      console.log("    Claude Code:");
      console.log("      /skill linch:bootstrap");
      console.log("");
    }
    if (
      selectedTools.includes("cursor") ||
      selectedTools.includes("trae") ||
      selectedTools.includes("codex") ||
      selectedTools.includes("copilot")
    ) {
      console.log("    Cursor / Codex / Trae / Copilot:");
      console.log("      I just created this LinchKit project. Help me set it up:");
      console.log("      ask what I want to build, recommend and install capabilities,");
      console.log("      then help me define entities, actions, and rules.");
      console.log("");
    }
  },
});
