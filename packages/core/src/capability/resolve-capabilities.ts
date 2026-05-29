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

  for (const [index, cap] of explicit.entries()) {
    assertNamedCapability(cap, "explicit", index);
    if (!byName.has(cap.name)) order.push(cap.name);
    byName.set(cap.name, cap);
  }
  for (const [index, cap] of discovered.entries()) {
    assertNamedCapability(cap, "discovered", index);
    if (byName.has(cap.name)) continue; // explicit wins
    byName.set(cap.name, cap);
    order.push(cap.name);
  }

  return order.map((name) => byName.get(name) as CapabilityDefinition);
}

/**
 * Fail-loud guard for a capability entry before its `name` is dereferenced.
 *
 * `explicit` capabilities come straight from `linchkit.config.ts` and reach
 * {@link mergeCapabilityPool} BEFORE `ConfigRegistry.create` validates them, so a
 * null/undefined entry or one missing a non-empty string `name` would otherwise
 * surface as a cryptic `TypeError`. A nameless capability is a config error, so
 * we throw with a message that pinpoints the source list and index.
 *
 * @param cap    - Candidate capability entry (untrusted at this stage)
 * @param source - Which list the entry came from, for the error message
 * @param index  - Position of the entry in its source list
 * @throws Error if `cap` is null/undefined or has no non-empty string `name`
 */
function assertNamedCapability(
  cap: CapabilityDefinition | null | undefined,
  source: "explicit" | "discovered",
  index: number,
): asserts cap is CapabilityDefinition {
  if (cap === null || cap === undefined) {
    throw new Error(
      `mergeCapabilityPool: ${source} capability at index ${index} is null/undefined`,
    );
  }
  if (typeof cap.name !== "string" || cap.name.trim() === "") {
    throw new Error(
      `mergeCapabilityPool: ${source} capability at index ${index} has no valid "name"`,
    );
  }
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
