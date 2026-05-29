/**
 * capability.json metadata schema — validated at install time.
 *
 * This defines the shape of the `capability.json` file that every published
 * LinchKit capability must include. Used by `linch install` to verify
 * compatibility and resolve dependencies before wiring a capability.
 */

import { z } from "zod";

// ── Enums ────────────────────────────────────────────

export const capabilityTypeEnum = z.enum(["standard", "adapter", "bridge"]);

export const capabilityCategoryEnum = z.enum([
  "system",
  "infrastructure",
  "integration",
  "business",
  "ui",
  "utility",
  "starter",
]);

// ── Extension manifest (declared, not runtime) ──────

const extensionManifestSchema = z.object({
  /** Entity names this capability provides */
  entities: z.array(z.string()).optional(),
  /** Action names this capability provides */
  actions: z.array(z.string()).optional(),
  /** Custom field type names this capability registers */
  fieldTypes: z.array(z.string()).optional(),
  /** Custom view type names */
  viewTypes: z.array(z.string()).optional(),
  /** Service identifiers exposed to the runtime */
  services: z.array(z.string()).optional(),
  /** Transport adapter names (e.g. "mcp", "a2a") */
  transports: z.array(z.string()).optional(),
  /** Custom rule effect names */
  ruleEffects: z.array(z.string()).optional(),
  /** Hook identifiers */
  hooks: z.array(z.string()).optional(),
  /** Middleware slot names */
  middlewares: z.array(z.string()).optional(),
  /** CLI command names */
  commands: z.array(z.string()).optional(),
});

// ── Main schema ─────────────────────────────────────

export const capabilityMetadataSchema = z.object({
  /** Package name, e.g. "@linchkit/cap-auth" */
  name: z.string().min(1),
  /** Semver version string */
  version: z.string().min(1),
  /** Capability type */
  type: capabilityTypeEnum,
  /** Capability category */
  category: capabilityCategoryEnum,
  /** Human-readable display name */
  label: z.string().min(1),
  /** Optional description */
  description: z.string().optional(),
  /** Other capability names this depends on */
  dependencies: z.array(z.string()).optional(),
  /** Which extension points this capability uses (declarative manifest) */
  extensions: extensionManifestSchema.optional(),
  /** Author name or organization */
  author: z.string().optional(),
  /** SPDX license identifier */
  license: z.string().optional(),
  /** Repository URL */
  repository: z.string().url().optional(),
  /** Main entry point (default: "src/index.ts") */
  main: z.string().optional().default("src/index.ts"),
  /** UI entry point for capabilities that provide frontend components */
  ui: z.string().optional(),
  /** Compatibility constraints */
  linchkit: z
    .object({
      /**
       * Semver RANGE describing which @linchkit/core versions this capability
       * is compatible with (e.g. "^0.2.0", ">=0.2.0 <0.4.0"). When present it
       * takes precedence over the deprecated `minVersion` / `minCoreVersion`.
       */
      coreVersion: z.string().optional(),
      /**
       * @deprecated Use `coreVersion` (a semver range) instead. Still honored
       * as a fallback when `coreVersion` is absent. Interpreted as a minimum
       * version constraint.
       */
      minVersion: z.string().optional(),
      /**
       * @deprecated Legacy alias of `minVersion` carried by shipped addons'
       * `package.json` (`linchkit.minCoreVersion`). Recognized so it is no
       * longer silently stripped at parse time; honored only when both
       * `coreVersion` and `minVersion` are absent. Interpreted as a minimum
       * version constraint (a bare version is normalized to a `>=` range).
       */
      minCoreVersion: z.string().optional(),
    })
    .optional(),
});

// ── Inferred type ───────────────────────────────────

export type CapabilityMetadata = z.infer<typeof capabilityMetadataSchema>;

// ── Validation helper ───────────────────────────────

export interface CapabilityMetadataValidationResult {
  success: true;
  data: CapabilityMetadata;
}

export interface CapabilityMetadataValidationError {
  success: false;
  errors: z.ZodIssue[];
}

/**
 * Parse and validate a capability.json payload.
 * Returns a discriminated result so callers can handle errors without try/catch.
 */
export function validateCapabilityMetadata(
  input: unknown,
): CapabilityMetadataValidationResult | CapabilityMetadataValidationError {
  const result = capabilityMetadataSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error.issues };
}
