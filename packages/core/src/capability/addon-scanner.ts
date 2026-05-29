import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CapabilityDefinition } from "../types/capability";
import { coreVersionRangeOf, type MetadataCompatibility } from "./compatibility";

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
          const pkgJson = (pkg.default ?? pkg) as {
            main?: string;
            linchkit?: MetadataCompatibility;
          };
          const mainEntry = pkgJson.main ?? "src/index.ts";
          const mod = await import(join(capPath, mainEntry));
          const capDef = mod.default ?? mod;

          if (capDef && typeof capDef === "object" && capDef.name && capDef.label) {
            // Shallow-copy rather than mutate `capDef` in place: a default export
            // may be `Object.freeze`d, and a named-export module resolves to a
            // frozen namespace object — assigning `coreVersion` on either throws
            // a TypeError that this try/catch would silently swallow, dropping
            // the addon. The copy is a plain extensible object we own.
            const def = { ...(capDef as CapabilityDefinition) };
            // Populate the boot-time compatibility range (Spec 21 / #122) from
            // the addon's `package.json` `linchkit` block (coreVersion ??
            // minVersion ?? minCoreVersion). The runtime definition rarely
            // declares `coreVersion` itself, so without this the boot check in
            // `enforceCoreCompatibility` would see `undefined` for every addon.
            // A range declared explicitly on the definition still wins.
            if (def.coreVersion === undefined) {
              const range = coreVersionRangeOf(pkgJson.linchkit);
              if (range !== undefined) def.coreVersion = range;
            }
            capabilities.push(def);
          }
        } catch {
          // Skip capabilities that fail to load
        }
      }
    }
  }

  return capabilities;
}
