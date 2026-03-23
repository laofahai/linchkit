/**
 * ConfigRegistry — immutable config store created at startup.
 *
 * Resolves env vars, validates all schemas, collects errors, then deep-freezes.
 */

import type { ZodError } from "zod";
import { LinchKitError } from "../errors";
import type { CapabilityDefinition } from "../types/capability";
import type { LinchKitConfig } from "../types/config";
import { resolveEnvVars } from "../utils/env";
import { databaseConfig, queueConfig, securityConfig, serverConfig } from "./system-schemas";

/** Deep-freeze an object recursively */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj as Readonly<T>;
}

/** System config section names mapped to their schemas */
const SYSTEM_SCHEMAS = [
  { key: "server", ref: serverConfig },
  { key: "database", ref: databaseConfig },
  { key: "queue", ref: queueConfig },
  { key: "security", ref: securityConfig },
] as const;

/** Format a single Zod error into human-readable lines */
function formatZodError(namespace: string, error: ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
    return `  ${namespace}${path}:\n    \u2717 ${issue.message}`;
  });
  return lines.join("\n");
}

export class ConfigRegistry {
  private readonly store = new Map<string, Readonly<Record<string, unknown>>>();

  private constructor() {}

  /** Create an empty registry (useful for tests or when no config is needed) */
  static empty(): ConfigRegistry {
    return new ConfigRegistry();
  }

  /**
   * Create a registry: resolve env vars -> validate all schemas -> freeze.
   * Collects all validation errors and reports them at once.
   */
  static create(rawConfig: LinchKitConfig, capabilities: CapabilityDefinition[]): ConfigRegistry {
    const registry = new ConfigRegistry();
    const errors: string[] = [];

    // Step 1-2: Resolve and validate system config sections
    for (const { key, ref } of SYSTEM_SCHEMAS) {
      const section = (rawConfig as Record<string, unknown>)[key] ?? {};
      const resolved = resolveEnvVars(section);
      const result = ref.schema.safeParse(resolved);
      if (result.success) {
        registry.store.set(ref.name, deepFreeze(result.data as Record<string, unknown>));
      } else {
        errors.push(formatZodError(ref.name, result.error));
      }
    }

    // Step 3: Resolve and validate capability configs
    // When configSchema is declared but no config is provided, validate with
    // empty object so Zod defaults are applied and the namespace is registered.
    for (const cap of capabilities) {
      if (cap.configSchema) {
        // Reject duplicate namespace registrations
        if (registry.store.has(cap.name)) {
          errors.push(
            `  ${cap.name}:\n    \u2717 Duplicate config namespace "${cap.name}" — already registered by a system schema or another capability`,
          );
          continue;
        }
        const raw = cap.config ?? {};
        const resolved = resolveEnvVars(raw);
        const result = cap.configSchema.safeParse(resolved);
        if (result.success) {
          registry.store.set(cap.name, deepFreeze(result.data as Record<string, unknown>));
        } else {
          errors.push(formatZodError(cap.name, result.error));
        }
      }
    }

    // Step 4: Report collected errors
    if (errors.length > 0) {
      const message = `[linch] Config validation failed:\n\n${errors.join("\n\n")}\n\nStartup aborted.`;
      throw new LinchKitError({ code: "config.validation.failed", message }, "validation");
    }

    return registry;
  }

  /** Get a config section by namespace name */
  get<T = Record<string, unknown>>(name: string): Readonly<T> {
    const section = this.store.get(name);
    if (section === undefined) {
      throw new LinchKitError(
        {
          code: "config.registry.not_found",
          message: `Config namespace "${name}" is not registered`,
        },
        "system",
      );
    }
    return section as Readonly<T>;
  }

  /** Check if a namespace is registered */
  has(name: string): boolean {
    return this.store.has(name);
  }

  /** Get all registered namespace names */
  keys(): string[] {
    return Array.from(this.store.keys());
  }
}
