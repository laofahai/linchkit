/**
 * linch install <package-name> — Install a capability package and validate its metadata.
 *
 * Runs `bun add`, then locates and validates the package's capability.json
 * using the CapabilityMetadata schema from @linchkit/core.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCapabilityMetadata } from "@linchkit/core";
import { defineCommand } from "citty";

/**
 * Resolve the path to a package's capability.json.
 * Handles both npm packages (node_modules/<name>) and local paths.
 */
function resolveCapabilityJsonPath(packageName: string): string {
  if (packageName.startsWith(".") || packageName.startsWith("/")) {
    // Local path
    return resolve(process.cwd(), packageName, "capability.json");
  }
  // npm package — look in node_modules
  return resolve(process.cwd(), "node_modules", packageName, "capability.json");
}

/**
 * Summarize extensions from capability metadata for display.
 */
function summarizeExtensions(extensions: Record<string, unknown> | undefined): string {
  if (!extensions) return "none";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(extensions)) {
    if (Array.isArray(value) && value.length > 0) {
      parts.push(`${key}: ${value.join(", ")}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : "none";
}

export const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Install a capability package and validate its metadata",
  },
  args: {
    packageName: {
      type: "positional",
      description: "npm package name or local path (e.g. @linchkit/cap-auth or ./my-capability)",
      required: true,
    },
    dev: {
      type: "boolean",
      description: "Install as devDependency",
      default: false,
    },
  },
  async run({ args }) {
    const packageName = args.packageName;
    const isDev = args.dev;

    // Step 1: Run bun add
    const addArgs = ["bun", "add"];
    if (isDev) addArgs.push("-d");
    addArgs.push(packageName);

    console.log(`[linch] Installing ${packageName}...`);

    const result = Bun.spawnSync(addArgs, {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode !== 0) {
      console.error(`[linch] Failed to install ${packageName}`);
      process.exit(1);
    }

    console.log(`[linch] Package ${packageName} installed successfully.`);

    // Step 2: Locate capability.json
    const capabilityJsonPath = resolveCapabilityJsonPath(packageName);

    if (!existsSync(capabilityJsonPath)) {
      console.log(`[linch] No capability.json found at ${capabilityJsonPath}`);
      console.log(
        "[linch] This package may be a regular npm dependency (not a LinchKit capability).",
      );
      return;
    }

    // Step 3: Read and validate capability.json
    let raw: unknown;
    try {
      const content = readFileSync(capabilityJsonPath, "utf-8");
      raw = JSON.parse(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[linch] Failed to read capability.json: ${msg}`);
      return;
    }

    const validation = validateCapabilityMetadata(raw);

    if (!validation.success) {
      console.warn("[linch] capability.json validation failed:");
      for (const issue of validation.errors) {
        console.warn(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
      console.warn("[linch] Package is installed but metadata is invalid.");
      return;
    }

    const metadata = validation.data;

    // Step 4: Check dependencies
    const missingDeps: string[] = [];
    if (metadata.dependencies && metadata.dependencies.length > 0) {
      for (const dep of metadata.dependencies) {
        const depPath = resolve(process.cwd(), "node_modules", dep);
        if (!existsSync(depPath)) {
          missingDeps.push(dep);
        }
      }
    }

    // Step 5: Print success message
    console.log("");
    console.log(`[linch] Capability installed: ${metadata.label}`);
    console.log(`  Name:       ${metadata.name}`);
    console.log(`  Version:    ${metadata.version}`);
    console.log(`  Type:       ${metadata.type}`);
    console.log(`  Category:   ${metadata.category}`);
    if (metadata.description) {
      console.log(`  Description: ${metadata.description}`);
    }
    console.log(
      `  Extensions: ${summarizeExtensions(metadata.extensions as Record<string, unknown> | undefined)}`,
    );

    if (missingDeps.length > 0) {
      console.log("");
      console.warn("[linch] Missing capability dependencies:");
      for (const dep of missingDeps) {
        console.warn(`  - ${dep} (install with: linch install ${dep})`);
      }
    }
  },
});
