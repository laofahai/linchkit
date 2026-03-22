#!/usr/bin/env bun
/**
 * @linchkit/cli — CLI entry point
 *
 * Built on citty. Provides linch init / linch dev commands.
 */

import { defineCommand, runMain } from "citty";
import { devCommand } from "./commands/dev";
import { initCommand } from "./commands/init";

export const VERSION = "0.0.1";

const main = defineCommand({
  meta: {
    name: "linch",
    version: VERSION,
    description: "LinchKit CLI — AI-Native Software Capability Runtime",
  },
  subCommands: {
    init: initCommand,
    dev: devCommand,
  },
});

runMain(main);
