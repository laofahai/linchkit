import type { CapabilityDefinition } from "../types/capability";
import { resolveAutoInstall, resolveDependencies } from "./auto-install";

/**
 * Merge explicitly-configured capabilities with filesystem-discovered ones
 * into a single deduplicated pool, keyed by `name`.
 *
 * On a name collision the **explicit** definition wins: a capability that was
 * wired up via its factory in `linchkit.config.ts` (e.g. carrying a database
 * handle or custom options) must beat the bare default that `scanAddonsPath`
 * imported straight off disk.
 *
 * Order: explicit caps first (in their declared order), followed by any
 * discovered cap whose name was not already provided explicitly.
 *
 * @param explicit   - Capabilities explicitly listed by the user (config)
 * @param discovered - Capabilities found by scanning `addons_path`
 * @returns Deduplicated pool with explicit definitions taking precedence
 */
export function mergeCapabilityPool(
  explicit: CapabilityDefinition[],
  discovered: CapabilityDefinition[],
): CapabilityDefinition[] {
  const byName = new Map<string, CapabilityDefinition>();
  const order: string[] = [];

  for (const cap of explicit) {
    if (!byName.has(cap.name)) order.push(cap.name);
    byName.set(cap.name, cap);
  }
  for (const cap of discovered) {
    if (byName.has(cap.name)) continue; // explicit wins
    byName.set(cap.name, cap);
    order.push(cap.name);
  }

  return order.map((name) => byName.get(name) as CapabilityDefinition);
}

/**
 * Resolve the final active capability set for the boot path.
 *
 * Combines the two resolvers from `auto-install.ts` over a merged pool:
 *  1. {@link resolveDependencies} (PUSH) — walk the explicit caps' `dependencies`
 *     and pull matching caps out of the merged pool into the active set.
 *  2. {@link resolveAutoInstall} (PULL) — activate any pooled cap with
 *     `autoInstall: true` once all of its dependencies are present.
 *
 * Missing dependencies are silently skipped here — runtime validation owns
 * surfacing those as hard errors.
 *
 * @param explicit   - Capabilities explicitly requested (e.g. from config)
 * @param discovered - Capabilities found by scanning `addons_path`
 * @returns The active capability list (explicit + pulled deps + auto-installed)
 */
export function resolveCapabilities(
  explicit: CapabilityDefinition[],
  discovered: CapabilityDefinition[],
): CapabilityDefinition[] {
  const pool = mergeCapabilityPool(explicit, discovered);
  const withDeps = resolveDependencies(explicit, pool);
  return resolveAutoInstall(withDeps, pool);
}
