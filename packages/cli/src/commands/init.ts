/**
 * linch init [project-name] — Scaffold a new LinchKit project
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineCommand } from "citty";
import {
  agentsMdTemplate,
  agentsUserMdTemplate,
  claudeMdTemplate,
  envExampleTemplate,
  gitignoreTemplate,
  linchkitConfigTemplate,
  packageJsonTemplate,
  tsconfigTemplate,
} from "../templates";
import { type AiTool, ALL_AI_TOOLS, syncAiToolConfigs } from "./setup";

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
    const requestedName = args.name as string;
    const projectDir = resolve(process.cwd(), requestedName);
    const projectName = basename(projectDir);

    const selectedTools: AiTool[] = args["ai-tools"]
      ? (args["ai-tools"].split(",").map((t: string) => t.trim()) as AiTool[])
      : [...ALL_AI_TOOLS];

    if (existsSync(projectDir)) {
      console.error(`Error: Directory "${projectDir}" already exists.`);
      process.exit(1);
    }

    console.log(`Creating LinchKit project: ${projectDir}`);

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

    // Delegate AI tool config generation to shared setup logic
    const generatedAiFiles = syncAiToolConfigs({
      projectDir,
      projectName,
      tools: selectedTools,
      force: true,
    });

    console.log("");
    console.log("Project created successfully!");
    console.log("");
    console.log("  Project structure:");
    console.log(`  ${projectDir}/`);
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
    console.log(`    cd ${projectDir}`);
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
      console.log("      first read CLAUDE.md and AGENTS.md, then docs/specs/INDEX.md,");
      console.log("      treat GitHub milestones/issues as the execution source of truth,");
      console.log("      ask what I want to build, recommend and install capabilities,");
      console.log("      then help me define entities, actions, and rules via the relevant specs.");
      console.log("");
    }
  },
});
