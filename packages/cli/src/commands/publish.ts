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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TrustLevel } from "@linchkit/core";
import { validateCapabilityMetadata } from "@linchkit/core";
import { defineCommand } from "citty";
import { registerCapability } from "../utils/local-registry-io";

// ── Publish validation ──────────────────────────────────

export interface PublishCheck {
  name: string;
  passed: boolean;
  message: string;
}

/**
 * Run all publish readiness checks on a capability directory.
 */
export function runPublishChecks(capDir: string): {
  checks: PublishCheck[];
  metadata: ReturnType<typeof validateCapabilityMetadata> extends infer R
    ? R extends { success: true; data: infer D }
      ? D
      : null
    : null;
} {
  const checks: PublishCheck[] = [];
  let metadata: ReturnType<typeof runPublishChecks>["metadata"] = null;

  // 1. capability.json exists
  const capJsonPath = resolve(capDir, "capability.json");
  if (!existsSync(capJsonPath)) {
    checks.push({
      name: "capability.json",
      passed: false,
      message: "capability.json not found in the current directory",
    });
    return { checks, metadata };
  }
  checks.push({
    name: "capability.json",
    passed: true,
    message: "capability.json found",
  });

  // 2. capability.json validates
  let raw: unknown;
  try {
    const content = readFileSync(capJsonPath, "utf-8");
    raw = JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "capability.json parse",
      passed: false,
      message: `Failed to parse capability.json: ${msg}`,
    });
    return { checks, metadata };
  }

  const validation = validateCapabilityMetadata(raw);
  if (!validation.success) {
    const errors = validation.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
    checks.push({
      name: "capability.json validation",
      passed: false,
      message: `Validation failed: ${errors}`,
    });
    return { checks, metadata };
  }

  metadata = validation.data;
  checks.push({
    name: "capability.json validation",
    passed: true,
    message: "All required fields present and valid",
  });

  // 3. Semver version check
  const semverRe = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
  if (semverRe.test(metadata.version)) {
    checks.push({
      name: "version",
      passed: true,
      message: `Valid semver: ${metadata.version}`,
    });
  } else {
    checks.push({
      name: "version",
      passed: false,
      message: `Invalid semver: "${metadata.version}"`,
    });
  }

  // 4. package.json exists
  const pkgJsonPath = resolve(capDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    checks.push({
      name: "package.json",
      passed: true,
      message: "package.json found",
    });

    // Check peer dependency on @linchkit/core
    try {
      const pkgContent = readFileSync(pkgJsonPath, "utf-8");
      const pkg = JSON.parse(pkgContent);
      const peers = pkg.peerDependencies ?? {};
      if (peers["@linchkit/core"]) {
        checks.push({
          name: "peer dependency",
          passed: true,
          message: `@linchkit/core: ${peers["@linchkit/core"]}`,
        });
      } else {
        checks.push({
          name: "peer dependency",
          passed: false,
          message: "Missing peerDependencies on @linchkit/core",
        });
      }
    } catch {
      checks.push({
        name: "peer dependency",
        passed: false,
        message: "Failed to parse package.json",
      });
    }
  } else {
    checks.push({
      name: "package.json",
      passed: false,
      message: "package.json not found",
    });
  }

  // 5. README.md exists (warning, not error)
  const readmePath = resolve(capDir, "README.md");
  if (existsSync(readmePath)) {
    checks.push({
      name: "README.md",
      passed: true,
      message: "README.md found",
    });
  } else {
    checks.push({
      name: "README.md",
      passed: false,
      message: "No README.md — consider adding one for documentation",
    });
  }

  // 6. Test files exist (check common patterns)
  const testPatterns = [
    resolve(capDir, "__tests__"),
    resolve(capDir, "tests"),
    resolve(capDir, "test"),
    resolve(capDir, "src/__tests__"),
  ];
  const hasTests = testPatterns.some((p) => existsSync(p));
  checks.push({
    name: "tests",
    passed: hasTests,
    message: hasTests ? "Test directory found" : "No test directory found (recommend adding tests)",
  });

  return { checks, metadata };
}

// ── Determine trust level ───────────────────────────────

function inferTrustLevel(name: string): TrustLevel {
  if (name.startsWith("@linchkit/")) return "official";
  if (name.startsWith("linchkit-cap-")) return "community";
  return "unverified";
}

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
      // Register to local project registry
      const trustLevel = inferTrustLevel(metadata.name);
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
        // `minVersion` for capabilities that have not migrated yet.
        minCoreVersion: metadata.linchkit?.coreVersion ?? metadata.linchkit?.minVersion,
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
