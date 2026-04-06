/**
 * linch init [project-name] — Scaffold a new LinchKit project
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
  agentsMdTemplate,
  claudeMdTemplate,
  envExampleTemplate,
  gitignoreTemplate,
  linchkitConfigTemplate,
  packageJsonTemplate,
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
  },
  run({ args }) {
    const projectName = args.name;
    const projectDir = resolve(process.cwd(), projectName);

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
    const dbName = projectName.replace(/-/g, "_");
    writeFileSync(resolve(projectDir, "linchkit.config.ts"), linchkitConfigTemplate(dbName));
    writeFileSync(resolve(projectDir, "package.json"), packageJsonTemplate(projectName));
    writeFileSync(resolve(projectDir, "tsconfig.json"), tsconfigTemplate());
    writeFileSync(resolve(projectDir, "CLAUDE.md"), claudeMdTemplate(projectName));
    writeFileSync(resolve(projectDir, "AGENTS.md"), agentsMdTemplate(projectName));

    // Write env and gitignore files
    writeFileSync(resolve(projectDir, ".env.example"), envExampleTemplate());
    writeFileSync(resolve(projectDir, ".env"), envExampleTemplate());
    writeFileSync(resolve(projectDir, ".gitignore"), gitignoreTemplate());

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
    console.log("    └── AGENTS.md");
    console.log("");
    console.log("  Next steps:");
    console.log(`    cd ${projectName}`);
    console.log("    bun install");
    console.log("    linch dev");
  },
});
