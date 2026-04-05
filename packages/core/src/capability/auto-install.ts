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
