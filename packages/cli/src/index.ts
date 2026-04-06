#!/usr/bin/env bun
/**
 * @linchkit/cli — CLI entry point
 *
 * Built on citty. Provides built-in commands and dynamically discovers
 * capability-registered CLI commands via extensions.commands.
 */

// Suppress i18next sponsorship banner (hardcoded console.info in i18next v25+)
const _origInfo = console.info;
console.info = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("i18next")) return;
  _origInfo(...args);
};

import type { CliCommand, CliCommandContext } from "@linchkit/core";
import { defineCommand, runMain, showUsage } from "citty";
import { agentsMdCommand } from "./commands/agents-md";
import { changelogCommand } from "./commands/changelog";
import { checkQualityCommand } from "./commands/check-quality";
import { createCommand } from "./commands/create";
import { dbCommand } from "./commands/db";
import { describeCommand } from "./commands/describe";
import { devCommand } from "./commands/dev";
import { doctorCommand } from "./commands/doctor";
import { docsCommand } from "./commands/docs";
import { infoCommand } from "./commands/info";
import { initCommand } from "./commands/init";
import { installCommand } from "./commands/install";
import { publishCommand } from "./commands/publish";
import { searchCommand } from "./commands/search";
import { collectCapabilityDefinitions } from "./commands/startup/collect-capabilities";
import { uninstallCommand } from "./commands/uninstall";
import { updateCommand } from "./commands/update";
import { mcpDevCommand } from "./commands/mcp-dev";
import { validateCommand } from "./commands/validate";
import { loadConfig } from "./utils/load-config";

export const VERSION = "0.0.1";

/** Reserved namespace names that capabilities cannot override. */
const RESERVED_NAMESPACES = new Set([
  "init",
  "dev",
  "db",
  "create",
  "install",
  "uninstall",
  "search",
  "update",
  "publish",
  "info",
  "validate",
  "check",
  "docs",
  "changelog",
  "doctor",
  "describe",
  "agents-md",
  "mcp-dev",
]);

/**
 * Build citty sub-commands from capability-registered CliCommands.
 * Commands are grouped by namespace; namespaced commands become
 * sub-command trees (`linch <namespace> <command>`).
 */
function buildCommandTree(
  commands: CliCommand[],
): Record<string, ReturnType<typeof defineCommand>> {
  const tree: Record<string, ReturnType<typeof defineCommand>> = {};
  const byNamespace: Record<string, CliCommand[]> = {};

  for (const cmd of commands) {
    const ns = cmd.namespace ?? "__root__";
    if (!byNamespace[ns]) byNamespace[ns] = [];
    byNamespace[ns].push(cmd);
  }

  for (const [ns, cmds] of Object.entries(byNamespace)) {
    if (ns === "__root__") continue;
    if (RESERVED_NAMESPACES.has(ns)) {
      console.warn(`[linch] Namespace "${ns}" is reserved, skipping capability commands`);
      continue;
    }

    tree[ns] = defineCommand({
      meta: { name: ns, description: cmds[0]?.description ?? ns },
      subCommands: Object.fromEntries(
        cmds.map((cmd) => [
          cmd.name,
          defineCommand({
            meta: { name: cmd.name, description: cmd.description },
            args: cmd.args
              ? Object.fromEntries(
                  Object.entries(cmd.args).map(([k, v]) => {
                    const arg: Record<string, unknown> = {
                      type: v.type === "number" ? "string" : v.type,
                      description: v.description,
                    };
                    if (v.default !== undefined) arg.default = String(v.default);
                    if (v.required) arg.required = v.required;
                    if (v.alias) arg.alias = v.alias;
                    return [k, arg];
                  }),
                )
              : undefined,
            async run({ args }) {
              const ctx: CliCommandContext = {
                args,
                config: {},
                capabilities: [],
                cwd: process.cwd(),
              };
              await cmd.handler(ctx);
            },
          }),
        ]),
      ),
    });
  }

  return tree;
}

/**
 * Discover capability commands from linchkit.config.ts.
 * Returns empty results if no config is found (e.g. before `linch init`).
 */
async function discoverCapabilityCommands(): Promise<{
  tree: Record<string, ReturnType<typeof defineCommand>>;
  commands: CliCommand[];
}> {
  try {
    const { config } = await loadConfig();
    if (!config?.capabilities) return { tree: {}, commands: [] };
    const collected = collectCapabilityDefinitions(config.capabilities);
    return {
      tree: buildCommandTree(collected.commands),
      commands: collected.commands,
    };
  } catch {
    return { tree: {}, commands: [] };
  }
}

/**
 * Build the commands manifest (JSON) for AI agent discovery.
 */
function buildCommandsManifest(
  builtinNames: string[],
  capabilityCommands: CliCommand[],
): Record<string, unknown> {
  const commands: Record<string, unknown> = {};

  const builtinDescriptions: Record<string, string> = {
    init: "Initialize a new LinchKit project",
    dev: "Start all LinchKit transports in development mode",
    db: "Database management (generate, migrate, studio)",
    create: "Create a new capability scaffold",
    install: "Install a capability from the registry",
    uninstall: "Uninstall a capability",
    search: "Search installed capabilities",
    update: "Update capability dependencies",
    publish: "Validate and publish a capability",
    info: "Show project metadata",
    validate: "Run comprehensive validation",
    check: "Run code quality checks",
    docs: "Generate documentation",
    changelog: "Generate changelog entries",
    doctor: "Run project health checks",
    describe:
      "Show project meta-model overview (entities, actions, rules, states, flows, relations)",
    "agents-md": "Generate AGENTS.md from project ontology",
  };

  for (const name of builtinNames) {
    commands[name] = { description: builtinDescriptions[name] ?? name };
  }

  for (const cmd of capabilityCommands) {
    const key = cmd.namespace ? `${cmd.namespace}:${cmd.name}` : cmd.name;
    const entry: Record<string, unknown> = { description: cmd.description };
    if (cmd.examples?.length) entry.examples = cmd.examples;
    if (cmd.args) {
      entry.args = Object.fromEntries(
        Object.entries(cmd.args).map(([k, v]) => [
          k,
          {
            type: v.type,
            description: v.description,
            required: v.required ?? false,
          },
        ]),
      );
    }
    if (cmd.interactive) entry.interactive = true;
    commands[key] = entry;
  }

  return { version: VERSION, commands };
}

async function run() {
  const builtinCommands = {
    init: initCommand,
    dev: devCommand,
    db: dbCommand,
    create: createCommand,
    install: installCommand,
    uninstall: uninstallCommand,
    update: updateCommand,
    search: searchCommand,
    publish: publishCommand,
    info: infoCommand,
    docs: docsCommand,
    check: checkQualityCommand,
    changelog: changelogCommand,
    validate: validateCommand,
    doctor: doctorCommand,
    describe: describeCommand,
    "agents-md": agentsMdCommand,
  };

  const { tree: capCommands, commands: capCommandList } = await discoverCapabilityCommands();

  const main = defineCommand({
    meta: {
      name: "linch",
      version: VERSION,
      description: "LinchKit CLI — AI-Native Software Capability Runtime",
    },
    args: {
      commands: {
        type: "boolean",
        description: "Show all available commands as JSON (for AI agents)",
        default: false,
      },
    },
    subCommands: { ...builtinCommands, ...capCommands },
    run({ args, cmd, rawArgs }) {
      if (args.commands) {
        const manifest = buildCommandsManifest(Object.keys(builtinCommands), capCommandList);
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }
      // Only show help when no subcommand was given
      const subCmd = rawArgs.find((a: string) => !a.startsWith("-") && a !== "linch");
      if (!subCmd) {
        showUsage(cmd);
      }
    },
  });

  runMain(main);
}

run();
