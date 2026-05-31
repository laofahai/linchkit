/**
 * Publish command — pure business logic extracted from publish.ts so it can
 * be imported and tested without pulling in the citty CLI framework.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCapabilityMetadata } from "@linchkit/core";

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

  // 6. Test files exist
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
