/**
 * linch agents-md — Generate AGENTS.md from current project ontology
 *
 * Introspects capabilities, entities, actions, relations, rules, and states
 * to produce a comprehensive AGENTS.md that teaches AI coding tools
 * how to work with this specific LinchKit project.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CapabilityDefinition } from "@linchkit/core";
import { generateAgentsMd, initI18n, registerTranslations } from "@linchkit/core";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";

export const agentsMdCommand = defineCommand({
  meta: {
    name: "agents-md",
    description: "Generate AGENTS.md from project ontology (entities, actions, relations, etc.)",
  },
  args: {
    output: {
      type: "string",
      description: "Output file path (default: AGENTS.md in project root)",
      default: "AGENTS.md",
    },
    "dry-run": {
      type: "boolean",
      description: "Print to stdout instead of writing to file",
      default: false,
    },
  },
  async run({ args }) {
    const dryRun = args["dry-run"] as boolean;
    const outputPath = args.output as string;

    // Load project config
    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
      config = await loadConfig();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Config file not found")) {
        console.error(
          "[linch] No linchkit.config.ts found. Are you in a LinchKit project directory?",
        );
        console.error("[linch] Run 'linch init' to create a new project.");
      } else {
        console.error(`[linch] Failed to load config: ${msg}`);
      }
      process.exit(1);
    }

    const capabilities = (config.config.capabilities ?? []) as CapabilityDefinition[];

    // Initialize core i18n and register capability translations
    await initI18n();
    for (const cap of capabilities) {
      if (cap.extensions?.i18n) {
        for (const [locale, resources] of Object.entries(cap.extensions.i18n)) {
          registerTranslations(cap.name, locale, resources as Record<string, unknown>);
        }
      }
    }

    // Collect all definitions from capabilities
    const entities = capabilities.flatMap((c) => c.entities ?? []);
    const actions = capabilities.flatMap((c) => c.actions ?? []);
    const relations = capabilities.flatMap((c) => c.relations ?? []);
    const rules = capabilities.flatMap((c) => c.rules ?? []);
    const states = capabilities.flatMap((c) => c.states ?? []);

    // Derive project name from config path directory
    const projectDir = resolve(config.configPath, "..");
    const projectName = projectDir.split("/").pop() ?? "LinchKit Project";

    const content = generateAgentsMd({
      projectName,
      config: config.config,
      capabilities,
      entities,
      actions,
      relations,
      rules,
      states,
    });

    if (dryRun) {
      console.log(content);
      return;
    }

    const fullPath = resolve(process.cwd(), outputPath);
    writeFileSync(fullPath, content, "utf-8");
    console.log(`[linch] AGENTS.md generated at ${fullPath}`);
    console.log(
      `[linch] Documented: ${entities.length} entities, ${actions.length} actions, ${relations.length} relations, ${rules.length} rules, ${states.length} states`,
    );
  },
});
