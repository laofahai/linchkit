/**
 * linch doctor — Project health check
 *
 * Runs all registered doctor checks grouped by category.
 * Core provides built-in checks; capabilities register their own
 * via `registerDoctorCheck()`.
 */

import type {
  CheckCategory,
  DoctorCheck,
  DoctorCheckResult,
  DoctorContext,
  LinchKitConfig,
} from "@linchkit/core";
import { builtinChecks, getDoctorChecks, registerDoctorCheck } from "@linchkit/core/server";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";

// ── Status icons ───────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  pass: "\u2705",
  fail: "\u274C",
  warn: "\u26A0\uFE0F",
  skip: "\u23ED\uFE0F",
};

const CATEGORY_LABELS: Record<CheckCategory, string> = {
  runtime: "Runtime Environment",
  database: "Database",
  definitions: "Definitions",
  quality: "Code Quality",
  capability: "Capabilities",
};

const CATEGORY_ORDER: CheckCategory[] = [
  "runtime",
  "database",
  "definitions",
  "quality",
  "capability",
];

// ── Command ────────────────────────────────────────────────────

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Run project health checks",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON (for AI tools to parse)",
      default: false,
    },
    category: {
      type: "string",
      description:
        "Only run checks in a specific category (runtime, database, definitions, quality, capability)",
    },
  },
  async run({ args }) {
    const outputJson = args.json as boolean;
    const filterCategory = args.category as string | undefined;

    // Load project config (optional — doctor should work even without config)
    let config: LinchKitConfig | undefined;
    const projectRoot = process.cwd();
    let hasDatabase = false;

    try {
      const result = await loadConfig();
      config = result.config;
      // Determine hasDatabase from config
      const dbUrl = config?.database?.url;
      if (dbUrl) {
        // Resolve $env.VAR patterns
        if (dbUrl.startsWith("$env.")) {
          const envVar = dbUrl.replace("$env.", "");
          hasDatabase = !!process.env[envVar];
        } else {
          hasDatabase = true;
        }
      }
    } catch {
      // No config — continue with defaults
    }

    // Register built-in checks
    for (const check of builtinChecks) {
      registerDoctorCheck(check);
    }

    // Build context
    const ctx: DoctorContext = {
      projectRoot,
      config: config as unknown as Record<string, unknown>,
      hasDatabase,
    };

    // Get all checks and filter by category if requested
    let checks = getDoctorChecks();
    if (filterCategory) {
      checks = checks.filter((c) => c.category === filterCategory);
    }

    if (!outputJson) {
      console.log("");
      console.log("  LinchKit Project Health Check");
      console.log("  ==============================");
      console.log("");
    }

    // Group checks by category
    const grouped = new Map<CheckCategory, DoctorCheck[]>();
    for (const check of checks) {
      const existing = grouped.get(check.category) ?? [];
      existing.push(check);
      grouped.set(check.category, existing);
    }

    // Run checks and collect results
    const allResults: DoctorCheckResult[] = [];
    const resultsByCategory = new Map<CheckCategory, DoctorCheckResult[]>();

    for (const category of CATEGORY_ORDER) {
      const categoryChecks = grouped.get(category);
      if (!categoryChecks || categoryChecks.length === 0) continue;

      if (!outputJson) {
        console.log(`  ${CATEGORY_LABELS[category] ?? category}`);
        console.log(`  ${"─".repeat((CATEGORY_LABELS[category] ?? category).length)}`);
      }

      const categoryResults: DoctorCheckResult[] = [];

      for (const check of categoryChecks) {
        let result: DoctorCheckResult;
        try {
          result = await check.run(ctx);
        } catch (err) {
          // Doctor should never crash — catch unexpected errors
          const msg = err instanceof Error ? err.message : String(err);
          result = {
            name: check.name,
            status: "fail",
            message: `Check threw an error: ${msg}`,
            suggestion: "This may indicate a bug in the check implementation",
          };
        }

        categoryResults.push(result);
        allResults.push(result);

        if (!outputJson) {
          const icon = STATUS_ICON[result.status] ?? "?";
          console.log(`    ${icon} ${result.name}: ${result.message}`);
        }
      }

      resultsByCategory.set(category, categoryResults);

      if (!outputJson) {
        console.log("");
      }
    }

    // Collect suggestions for fail/warn results
    const suggestions = allResults.filter(
      (r) => (r.status === "fail" || r.status === "warn") && r.suggestion,
    );

    if (outputJson) {
      // JSON output
      const output = {
        passed: allResults.every((r) => r.status !== "fail"),
        summary: {
          total: allResults.length,
          pass: allResults.filter((r) => r.status === "pass").length,
          fail: allResults.filter((r) => r.status === "fail").length,
          warn: allResults.filter((r) => r.status === "warn").length,
          skip: allResults.filter((r) => r.status === "skip").length,
        },
        results: allResults,
        suggestions: suggestions.map((r) => ({
          check: r.name,
          status: r.status,
          suggestion: r.suggestion,
        })),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      // Print suggestions
      if (suggestions.length > 0) {
        console.log("  Suggestions");
        console.log("  ───────────");
        for (const r of suggestions) {
          const icon = r.status === "fail" ? "\u274C" : "\u26A0\uFE0F";
          console.log(`    ${icon} ${r.name}: ${r.suggestion}`);
        }
        console.log("");
      }

      // Summary
      const passCount = allResults.filter((r) => r.status === "pass").length;
      const failCount = allResults.filter((r) => r.status === "fail").length;
      const warnCount = allResults.filter((r) => r.status === "warn").length;
      const skipCount = allResults.filter((r) => r.status === "skip").length;

      console.log(
        `  ${failCount === 0 ? "\u2705" : "\u274C"} ${passCount} passed, ${failCount} failed, ${warnCount} warnings, ${skipCount} skipped`,
      );
      console.log("");
    }

    // Exit with code 1 if any check failed
    const hasFailed = allResults.some((r) => r.status === "fail");
    if (hasFailed) {
      process.exit(1);
    }
  },
});
