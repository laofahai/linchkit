import type { CapabilityDefinition } from "../types/capability";

/**
 * Resolve autoInstall capabilities using fixed-point iteration.
 *
 * Repeatedly scans discovered capabilities, activating any with
 * autoInstall=true whose dependencies are all in the active set.
 * Continues until no new capabilities are activated (fixed point).
 *
 * @param explicit - Capabilities explicitly listed by the user
 * @param discovered - All capabilities discovered from addons_path
 * @returns Merged list: explicit + auto-installed (no duplicates)
 */
export function resolveAutoInstall(
  explicit: CapabilityDefinition[],
  discovered: CapabilityDefinition[],
): CapabilityDefinition[] {
  const activeNames = new Set(explicit.map((c) => c.name));
  const candidates = discovered.filter((c) => c.autoInstall && !activeNames.has(c.name));
  const activated: CapabilityDefinition[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const cap of candidates) {
      if (activeNames.has(cap.name)) continue;
      const depsOk = (cap.dependencies ?? []).every((d) => activeNames.has(d));
      if (depsOk) {
        activeNames.add(cap.name);
        activated.push(cap);
        changed = true;
      }
    }
  }

  return [...explicit, ...activated];
}

/**
 * Resolve transitive hard dependencies for an explicit capability set.
 *
 * When capabilities are explicitly activated (e.g. from linchkit.config.ts
 * or a starter pack), this function walks their `dependencies` arrays and
 * pulls matching capabilities from the `available` pool into the active set,
 * repeating until the set stabilises (fixed-point / BFS).
 *
 * This is the "push" complement to `resolveAutoInstall` (which is "pull"):
 * - resolveAutoInstall: auto-install me when my deps appear in the active set
 * - resolveDependencies: when I am explicitly installed, also pull in my deps
 *
 * Missing dependencies (names not found in `available`) are silently skipped —
 * runtime validation is responsible for surfacing those as hard errors.
 *
 * Recommended call sequence in startup:
 * ```
 * const discovered  = await scanAddonsPath(config.addons_path ?? []);
 * const withDeps    = resolveDependencies(config.capabilities ?? [], discovered);
 * const activeCaps  = resolveAutoInstall(withDeps, discovered);
 * ```
 *
 * @param explicit  - Capabilities explicitly requested (e.g. from config)
 * @param available - Pool of all capabilities that can satisfy dependencies
 * @returns Deduplicated list: explicit + all transitively reachable hard deps
 */
export function resolveDependencies(
  explicit: CapabilityDefinition[],
  available: CapabilityDefinition[],
): CapabilityDefinition[] {
  // Build lookup: explicit caps can also satisfy each other's deps.
  // If the same name appears in both, the explicit version wins.
  const byName = new Map<string, CapabilityDefinition>();
  for (const cap of available) {
    byName.set(cap.name, cap);
  }
  for (const cap of explicit) {
    byName.set(cap.name, cap);
  }

  const active = new Set<string>();
  const result: CapabilityDefinition[] = [];

  for (const cap of explicit) {
    if (active.has(cap.name)) continue;
    active.add(cap.name);
    result.push(cap);
  }

  for (let i = 0; i < result.length; i++) {
    const cap = result[i];
    if (!cap) break;
    for (const depName of cap.dependencies ?? []) {
      if (active.has(depName)) continue;
      const dep = byName.get(depName);
      if (dep) {
        active.add(depName);
        result.push(dep);
      }
      // Missing dep: silently skip; validation will catch it later
    }
  }

  return result;
}
