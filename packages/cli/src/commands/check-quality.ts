/**
 * linch check — Run code quality and convention checks
 *
 * Validates naming conventions, project structure, schema definitions,
 * and action definitions per LinchKit methodology (spec 29).
 * Reports issues as a formatted table with severity levels.
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  LinchKitConfig,
  EntityDefinition,
} from "@linchkit/core";
import type {
  ActionInfo,
  DirectoryEntry,
  EntityInfo,
  QualityIssue,
  QualityReport,
} from "@linchkit/devtools/methodology";
import {
  checkActionDefinitions,
  checkEntityDefinitions,
  validateProjectStructure,
} from "@linchkit/devtools/methodology";
import { defineCommand } from "citty";
import consola from "consola";
import { loadConfig } from "../utils/load-config";

export const checkQualityCommand = defineCommand({
  meta: {
    name: "check",
    description:
      "Run quality checks: naming conventions, project structure, schema/action conventions",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const outputJson = args.json as boolean;

    // Load project config
    let config: LinchKitConfig;
    try {
      const result = await loadConfig();
      config = result.config;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Config file not found")) {
        consola.error("No linchkit.config.ts found. Are you in a LinchKit project directory?");
        consola.info("Run 'linch init' to create a new project.");
      } else {
        consola.error(`Failed to load config: ${msg}`);
      }
      process.exit(1);
    }

    const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];
    const allIssues: QualityIssue[] = [];
    const reportSummaries: Array<{ name: string; report: QualityReport }> = [];

    // 1. Project structure check
    consola.start("Checking project structure...");
    const projectEntries = await scanDirectory(process.cwd());
    const structureReport = validateProjectStructure(process.cwd(), projectEntries);
    reportSummaries.push({ name: "Project Structure", report: structureReport });
    allIssues.push(...structureReport.issues);

    // 2. Schema definition checks
    consola.start("Checking schema definitions...");
    const schemas: EntityInfo[] = [];
    for (const cap of capabilities) {
      if (cap.entities) {
        for (const s of cap.entities as EntityDefinition[]) {
          schemas.push({
            name: s.name,
            fields: Object.entries(s.fields).map(([name, field]) => ({
              name,
              type: field.type,
            })),
          });
        }
      }
    }
    const schemaReport = checkEntityDefinitions(schemas);
    reportSummaries.push({ name: "Schema Conventions", report: schemaReport });
    allIssues.push(...schemaReport.issues);

    // 3. Action definition checks
    consola.start("Checking action definitions...");
    const actions: ActionInfo[] = [];
    for (const cap of capabilities) {
      if (cap.actions) {
        for (const a of cap.actions as ActionDefinition[]) {
          actions.push({ name: a.name, entity: a.entity });
        }
      }
    }
    const actionReport = checkActionDefinitions(actions);
    reportSummaries.push({ name: "Action Conventions", report: actionReport });
    allIssues.push(...actionReport.issues);

    // Aggregate summary
    const totalErrors = allIssues.filter((i) => i.severity === "error").length;
    const totalWarnings = allIssues.filter((i) => i.severity === "warning").length;
    const totalInfos = allIssues.filter((i) => i.severity === "info").length;

    if (outputJson) {
      console.log(
        JSON.stringify(
          {
            passed: totalErrors === 0,
            summary: {
              errors: totalErrors,
              warnings: totalWarnings,
              infos: totalInfos,
            },
            checks: reportSummaries.map((r) => ({
              name: r.name,
              passed: r.report.passed,
              summary: r.report.summary,
              issues: r.report.issues,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      // Print per-check summaries
      console.log("");
      for (const { name, report } of reportSummaries) {
        const icon = report.passed ? "\u2713" : "\u2717";
        console.log(
          `  ${icon} ${name}: ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.infos} info`,
        );
      }

      // Print issues table
      if (allIssues.length > 0) {
        console.log("");
        printIssuesTable(allIssues);
      }

      // Final summary
      console.log("");
      if (totalErrors === 0) {
        consola.success(`All checks passed. ${totalWarnings} warning(s), ${totalInfos} info(s).`);
      } else {
        consola.error(
          `${totalErrors} error(s), ${totalWarnings} warning(s), ${totalInfos} info(s).`,
        );
      }
    }

    if (totalErrors > 0) {
      process.exit(1);
    }
  },
});

/**
 * Scan a directory to produce DirectoryEntry[] for structure validation.
 */
async function scanDirectory(rootDir: string): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];
  const { readdir, stat } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");

  try {
    const items = await readdir(rootDir);
    for (const item of items) {
      if (item.startsWith(".") || item === "node_modules") continue;
      const fullPath = join(rootDir, item);
      try {
        const s = await stat(fullPath);
        entries.push({
          path: item,
          isDirectory: s.isDirectory(),
        });
        // Scan one level deeper for src/
        if (s.isDirectory() && item === "src") {
          const subItems = await readdir(fullPath);
          for (const sub of subItems) {
            if (sub.startsWith(".")) continue;
            const subPath = join(fullPath, sub);
            const subStat = await stat(subPath);
            entries.push({
              path: relative(rootDir, subPath),
              isDirectory: subStat.isDirectory(),
            });
          }
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Root dir not readable
  }

  return entries;
}

/**
 * Print issues as a formatted table.
 */
function printIssuesTable(issues: QualityIssue[]): void {
  const SEVERITY_COLORS: Record<string, string> = {
    error: "\x1b[31m",
    warning: "\x1b[33m",
    info: "\x1b[36m",
  };
  const RESET = "\x1b[0m";

  // Column widths
  const sevWidth = 8;
  const ruleWidth = Math.min(Math.max(...issues.map((i) => i.rule.length), 4), 30);

  const header = `  ${"Severity".padEnd(sevWidth)}  ${"Rule".padEnd(ruleWidth)}  Message`;
  const separator = `  ${"─".repeat(sevWidth)}  ${"─".repeat(ruleWidth)}  ${"─".repeat(50)}`;

  console.log(header);
  console.log(separator);

  for (const issue of issues) {
    const color = SEVERITY_COLORS[issue.severity] ?? "";
    const sev = `${color}${issue.severity.padEnd(sevWidth)}${RESET}`;
    const rule = issue.rule.padEnd(ruleWidth);
    const loc = issue.file ? ` [${issue.file}${issue.line ? `:${issue.line}` : ""}]` : "";
    console.log(`  ${sev}  ${rule}  ${issue.message}${loc}`);
  }
}
