/**
 * linch release-check — Static migration compatibility analysis (Spec 38 §9)
 *
 * Reads all *.sql files in the Drizzle migrations directory, classifies each
 * DDL statement as safe / expand / contract / breaking, and reports the
 * overall ReleaseCompatibilityResult.  Exits 1 when blockers are found.
 *
 * Usage:
 *   linch release-check                       # auto-detects ./drizzle/migrations
 *   linch release-check --dir path/to/migrations
 *   linch release-check --file 0006_rename.sql
 *   linch release-check --json
 */

import { join } from "node:path";
import {
  analyzeFile,
  checkReleaseCompatibility,
  type MigrationAnalysis,
  type ReleaseCompatibilityResult,
} from "@linchkit/core";
import { defineCommand } from "citty";
import consola from "consola";

// ── Pure handlers (exported for unit tests) ──────────────────────────────────

export interface ReleaseCheckOptions {
  dir?: string;
  file?: string;
  json?: boolean;
  cwd?: string;
}

export interface ReleaseCheckOutput {
  result: ReleaseCompatibilityResult;
  analysis?: MigrationAnalysis;
}

export async function runReleaseCheck(opts: ReleaseCheckOptions): Promise<ReleaseCheckOutput> {
  const cwd = opts.cwd ?? process.cwd();

  if (opts.file) {
    const filePath = opts.file.startsWith("/") ? opts.file : join(cwd, opts.file);
    const analysis = await analyzeFile(filePath);
    return { result: analysis.result, analysis };
  }

  const migrationsDir = opts.dir
    ? opts.dir.startsWith("/")
      ? opts.dir
      : join(cwd, opts.dir)
    : join(cwd, "drizzle", "migrations");

  const result = await checkReleaseCompatibility(migrationsDir);
  return { result };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

const RELEASE_TYPE_LABEL: Record<string, string> = {
  safe: "✅  safe",
  expand: "✅  expand",
  contract: "⚠️   contract",
  breaking: "🚫  breaking",
};

function printResult(result: ReleaseCompatibilityResult): void {
  const label = RELEASE_TYPE_LABEL[result.releaseType] ?? result.releaseType;
  console.log(`\nRelease type     : ${label}`);
  console.log(`Old version read : ${result.oldVersionCanRead ? "yes" : "NO"}`);
  console.log(`Old version write: ${result.oldVersionCanWrite ? "yes" : "NO"}`);
  console.log(`Rollback mode    : ${result.rollbackMode}`);
  console.log(`Requires backfill: ${result.requiresBackfill ? "yes" : "no"}`);
  console.log(`Requires dual-write: ${result.requiresDualWrite ? "yes" : "no"}`);

  if (result.tenantOverrideImpact.length > 0) {
    console.log("\nTenant override impact:");
    for (const o of result.tenantOverrideImpact) {
      console.log(`  [${o.status}] tenant=${o.tenantId}  target=${o.target}`);
    }
  }

  if (result.blockers.length > 0) {
    console.log("\nBlockers:");
    for (const b of result.blockers) {
      console.log(`  ✗  ${b}`);
    }
  } else {
    console.log("\nNo blockers — release is safe to proceed.");
  }
}

function printAnalysis(analysis: MigrationAnalysis): void {
  console.log(`\nFile: ${analysis.file}`);
  console.log("Statements:");
  for (const s of analysis.statements) {
    const icon = s.type === "safe" || s.type === "expand" ? "  " : "! ";
    const preview = s.statement.length > 80 ? `${s.statement.slice(0, 77)}...` : s.statement;
    console.log(`  ${icon}[${s.type.padEnd(8)}] ${preview}`);
    console.log(`            → ${s.reason}`);
  }
}

// ── citty command ────────────────────────────────────────────────────────────

export const releaseCheckCommand = defineCommand({
  meta: {
    name: "release-check",
    description: "Analyze migration files for blue-green release compatibility (Spec 38 §9)",
  },
  args: {
    dir: {
      type: "string",
      description: "Path to migrations directory (default: ./drizzle/migrations)",
    },
    file: {
      type: "string",
      description: "Analyze a single .sql file instead of the full directory",
    },
    json: {
      type: "boolean",
      description: "Output result as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const opts: ReleaseCheckOptions = {
      dir: args.dir as string | undefined,
      file: args.file as string | undefined,
      json: args.json as boolean,
    };

    let output: ReleaseCheckOutput;
    try {
      output = await runReleaseCheck(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      consola.error(`Failed to analyze migrations: ${msg}`);
      process.exit(1);
    }

    const { result, analysis } = output;

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (analysis) {
        printAnalysis(analysis);
      }
      printResult(result);
    }

    if (result.blockers.length > 0) {
      if (!opts.json) {
        console.log("\n⛔  Release blocked. Resolve the issues above before deploying.");
      }
      process.exit(1);
    }
  },
});
