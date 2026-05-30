import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CapabilityDefinition } from "../types/capability";
import { type CapabilityMetadata, validateCapabilityMetadata } from "../types/capability-metadata";
import type { TrustLevel } from "../types/trust";
import { coreVersionRangeOf, type MetadataCompatibility } from "./compatibility";
import { computeEffectiveTrust } from "./trust";

/**
 * Load and validate the standalone `capability.json` manifest for a capability
 * directory (Spec 21 §7.2).
 *
 * Mirrors the loader used by `linch install`: read → JSON.parse → validate
 * against `capabilityMetadataSchema`. Returns `null` (never throws) when the
 * file is absent, unreadable, invalid JSON, or fails schema validation — the
 * caller falls back to `package.json` metadata. An invalid-but-present manifest
 * is reported via `console.warn` so authors notice the typo without losing the
 * addon (graceful degradation).
 */
export function loadCapabilityManifest(capPath: string): CapabilityMetadata | null {
  const manifestPath = join(capPath, "capability.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const result = validateCapabilityMetadata(raw);
    if (result.success) return result.data;
    const reason = result.errors
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    console.warn(
      `[linchkit] Ignoring invalid capability.json at ${manifestPath}: ${reason}; falling back to package.json`,
    );
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[linchkit] Ignoring invalid capability.json at ${manifestPath}: ${reason}; falling back to package.json`,
    );
    return null;
  }
}

/**
 * Scan addon_path directories for capability packages.
 *
 * Directory structure expected:
 *   {addonsPath}/{groupName}/cap-{name}/package.json
 *
 * Each cap-* directory is imported and its default export is
 * expected to be a CapabilityDefinition (or a factory that returns one).
 *
 * Declared metadata (coreVersion / trustLevel / dependencies) is resolved with
 * the following precedence, highest first (Spec 21 §7.2):
 *   (a) a value hardcoded on the code-exported definition — author wins;
 *   (b) the standalone `capability.json` manifest — HIGHER than package.json;
 *   (c) the `package.json` `linchkit` field — fallback.
 * A declared `trustLevel` from ANY source (code-def, capability.json, or
 * package.json `linchkit`) is always clamped via `computeEffectiveTrust`
 * (anti-spoof: a declaration can only LOWER standing, never raise it).
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
            name?: string;
            main?: string;
            linchkit?: MetadataCompatibility & { trustLevel?: TrustLevel };
          };
          // Standalone manifest (Spec 21 §7.2) — HIGHER priority than
          // package.json. Loaded defensively: a malformed manifest is logged
          // and ignored (null) so the addon still boots from package.json.
          const manifest = loadCapabilityManifest(capPath);
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

            // Populate the boot-time compatibility range (Spec 21 / #122).
            // Precedence: code-def `coreVersion` (if set) > capability.json
            // `linchkit` > package.json `linchkit`. The runtime definition
            // rarely declares `coreVersion` itself, so without this the boot
            // check in `enforceCoreCompatibility` would see `undefined`.
            // A range declared explicitly on the definition still wins.
            if (def.coreVersion === undefined) {
              const range =
                coreVersionRangeOf(manifest?.linchkit) ?? coreVersionRangeOf(pkgJson.linchkit);
              if (range !== undefined) def.coreVersion = range;
            }

            // Trust tier (Spec 21 / #122) — the anti-spoof clamp applies to EVERY declared
            // tier regardless of source. Precedence for the declared value:
            // code-def > capability.json > package.json `linchkit`. Whichever we take is
            // then ALWAYS clamped via computeEffectiveTrust. The clamp runs even when the
            // tier was hardcoded on the code export — otherwise a malicious addon could
            // ship `trustLevel: "official"` in src/index.ts and bypass the clamp entirely.
            const declaredTrust =
              def.trustLevel ?? manifest?.trustLevel ?? pkgJson.linchkit?.trustLevel;
            if (declaredTrust !== undefined) {
              // Clamp ceiling is inferred from the canonical publish name, NOT the short
              // runtime `def.name` (e.g. "cap-auth") which carries no scope/prefix and would
              // mis-infer every addon as `unverified`. Prefer the manifest name (higher
              // priority per §7.2), then package.json's name. Mirrors install.ts/publish.ts.
              const canonicalName = manifest?.name ?? pkgJson.name ?? def.name;
              def.trustLevel = computeEffectiveTrust({ name: canonicalName, declaredTrust });
            }

            // Dependencies declared in capability.json fill in when the code-def
            // does not list its own. package.json is intentionally NOT a fallback here:
            // capability dependencies live only in capability.json (§7.2), whereas
            // package.json's top-level `dependencies` are npm packages — a different concept.
            if (def.dependencies === undefined && manifest?.dependencies !== undefined) {
              def.dependencies = manifest.dependencies;
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
