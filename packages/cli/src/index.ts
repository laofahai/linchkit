#!/usr/bin/env bun
/**
 * @linchkit/cli — CLI entry point
 *
 * Built on citty. Provides linch init / linch dev commands.
 */

import { defineCommand, runMain } from "citty";
import { changelogCommand } from "./commands/changelog";
import { checkQualityCommand } from "./commands/check-quality";
import { createCommand } from "./commands/create";
import { dbCommand } from "./commands/db";
import { devCommand } from "./commands/dev";
import { docsCommand } from "./commands/docs";
import { infoCommand } from "./commands/info";
import { initCommand } from "./commands/init";
import { installCommand } from "./commands/install";

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
    db: dbCommand,
    create: createCommand,
    install: installCommand,
    info: infoCommand,
    docs: docsCommand,
    check: checkQualityCommand,
    changelog: changelogCommand,
  },
});

runMain(main);
