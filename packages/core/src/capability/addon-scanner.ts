import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CapabilityDefinition } from "../types/capability";

/**
 * Scan addon_path directories for capability packages.
 *
 * Directory structure expected:
 *   {addonsPath}/{groupName}/cap-{name}/package.json
 *
 * Each cap-* directory is imported and its default export is
 * expected to be a CapabilityDefinition (or a factory that returns one).
 */
export async function scanAddonsPath(addonsPaths: string[]): Promise<CapabilityDefinition[]> {
  const capabilities: CapabilityDefinition[] = [];

  for (const addonsPath of addonsPaths) {
    const absPath = resolve(addonsPath);
    if (!existsSync(absPath)) continue;

    const groups = readdirSync(absPath).filter((name) => {
      const full = join(absPath, name);
      return statSync(full).isDirectory() && !name.startsWith(".");
    });

    for (const group of groups) {
      const groupPath = join(absPath, group);
      const entries = readdirSync(groupPath).filter((name) => {
        const full = join(groupPath, name);
        return (
          name.startsWith("cap-") &&
          statSync(full).isDirectory() &&
          existsSync(join(full, "package.json"))
        );
      });

      for (const capDir of entries) {
        const capPath = join(groupPath, capDir);
        try {
          const pkg = await import(join(capPath, "package.json"));
          const mainEntry = pkg.default?.main ?? pkg.main ?? "src/index.ts";
          const mod = await import(join(capPath, mainEntry));
          const capDef = mod.default ?? mod;

          if (capDef && typeof capDef === "object" && capDef.name && capDef.label) {
            capabilities.push(capDef as CapabilityDefinition);
          }
        } catch {
          // Skip capabilities that fail to load
        }
      }
    }
  }

  return capabilities;
}
