/**
 * linch publish — Validate and prepare a capability for publishing
 *
 * Validates the capability.json, checks required files exist,
 * runs quality checks, and (in --local mode) registers the capability
 * to the local registry. For actual npm publish, delegates to bun publish.
 *
 * Checks:
 * - capability.json exists and validates
 * - package.json exists with correct peer dependencies
 * - README.md exists
 * - At least one test file exists
 * - Semver version is valid
 */

import { resolve } from "node:path";
import { computeEffectiveTrust, coreVersionRangeOf } from "@linchkit/core";
import { defineCommand } from "citty";
import { registerCapability } from "../utils/local-registry-io";
import { runPublishChecks } from "./publish-utils";

export type { PublishCheck } from "./publish-utils";
export { runPublishChecks } from "./publish-utils";

// ── Command ─────────────────────────────────────────────

export const publishCommand = defineCommand({
  meta: {
    name: "publish",
    description: "Validate and publish a capability (local registry or npm)",
  },
  args: {
    dir: {
      type: "string",
      description: "Capability directory (default: current directory)",
    },
    local: {
      type: "boolean",
      description: "Register to local project registry only (no npm publish)",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Validate only, do not actually publish",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output results as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const capDir = args.dir ? resolve(process.cwd(), args.dir as string) : process.cwd();
    const isLocal = args.local as boolean;
    const isDryRun = args["dry-run"] as boolean;
    const outputJson = args.json as boolean;

    const { checks, metadata } = runPublishChecks(capDir);

    const failedChecks = checks.filter((c) => !c.passed);
    // README and tests are warnings, not blockers
    const criticalFailures = failedChecks.filter(
      (c) => c.name !== "README.md" && c.name !== "tests",
    );

    if (outputJson) {
      console.log(
        JSON.stringify(
          {
            ready: criticalFailures.length === 0,
            checks,
            metadata: metadata ?? null,
          },
          null,
          2,
        ),
      );
      if (criticalFailures.length > 0) process.exit(1);
      return;
    }

    // Human-readable output
    console.log("\n  Publish readiness checks:\n");
    for (const check of checks) {
      const icon = check.passed ? "  PASS" : "  FAIL";
      console.log(`  ${icon}  ${check.name}: ${check.message}`);
    }
    console.log("");

    if (criticalFailures.length > 0) {
      console.error(
        `[linch] ${criticalFailures.length} critical check(s) failed. Fix them before publishing.`,
      );
      process.exit(1);
    }

    if (!metadata) {
      console.error("[linch] Could not extract metadata. Cannot publish.");
      process.exit(1);
    }

    if (isDryRun) {
      console.log("[linch] Dry run — all checks passed. Ready to publish.");
      return;
    }

    if (isLocal) {
      // Effective trust = clamp(declared ?? inferred). A capability MAY declare
      // a `trustLevel` in its capability.json, but the declaration can only
      // LOWER its standing — never exceed what the package name justifies
      // (anti-spoof). See `computeEffectiveTrust` in @linchkit/core.
      const trustLevel = computeEffectiveTrust({
        name: metadata.name,
        declaredTrust: metadata.trustLevel,
      });
      registerCapability(process.cwd(), {
        name: metadata.name,
        version: metadata.version,
        type: metadata.type,
        category: metadata.category,
        label: metadata.label,
        description: metadata.description,
        trustLevel,
        author: metadata.author,
        repository: metadata.repository,
        dependencies: metadata.dependencies,
        // Prefer the new `coreVersion` semver range; fall back to the deprecated
        // `minVersion` (normalized to a `>=` range) for capabilities that have
        // not migrated yet.
        minCoreVersion: coreVersionRangeOf(metadata.linchkit),
        installedAt: new Date().toISOString(),
      });

      console.log(
        `[linch] Capability "${metadata.name}" v${metadata.version} registered to local registry.`,
      );
      console.log(`  Trust level: ${trustLevel}`);
      return;
    }

    // npm publish via bun
    console.log(`[linch] Publishing ${metadata.name} v${metadata.version} to npm...`);

    const result = Bun.spawnSync(["bun", "publish"], {
      cwd: capDir,
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode !== 0) {
      console.error("[linch] npm publish failed.");
      process.exit(1);
    }

    console.log(`[linch] Published ${metadata.name} v${metadata.version} successfully.`);
  },
});
