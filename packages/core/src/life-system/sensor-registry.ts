/**
 * Sensor Registry — `extensions.sensors` slot for the Sense layer.
 *
 * Mirrors the pattern used by other extension slots in core
 * (see `doctor/doctor-registry.ts` for the canonical shape):
 * a module-level mutable registry plus a small set of pure helpers
 * (`registerSensor`, `getSensors`, `findSensor`, `unregisterSensor`,
 * `clearSensors`).
 *
 * Capabilities register their {@link Sensor} instances during boot;
 * the EvolutionRuntime reads the registered list and starts each one.
 *
 * @see ./abstractions.ts for the {@link Sensor} interface itself
 * @see docs/specs/55_evolution_system.md §3.3
 * @see docs/specs/56_core_slimming.md (Phase 2 Step 2a)
 */

import type { Sensor } from "./abstractions";

// ── Internal state ─────────────────────────────────────────────────────────

/**
 * Module-level Map keyed by {@link Sensor.id}. Using a Map (not an array) so
 * `registerSensor` can fail fast on duplicate IDs and `findSensor` is O(1).
 */
const sensors = new Map<string, Sensor>();

// ── Slot helpers ───────────────────────────────────────────────────────────

/**
 * Register a {@link Sensor} into the `extensions.sensors` slot.
 *
 * Throws if a sensor with the same `id` is already registered. Sensor IDs
 * must be globally unique because the EvolutionRuntime uses them as the
 * primary key for lifecycle management — silently overwriting would orphan
 * the previously-registered sensor's resources.
 */
export function registerSensor(sensor: Sensor): void {
  if (sensors.has(sensor.id)) {
    throw new Error(
      `Sensor "${sensor.id}" is already registered. Sensor IDs must be unique across all capabilities.`,
    );
  }
  sensors.set(sensor.id, sensor);
}

/**
 * Return all registered sensors as an array snapshot. Mutating the
 * returned array does not affect the registry.
 */
export function getSensors(): Sensor[] {
  return Array.from(sensors.values());
}

/**
 * Look up a single sensor by its {@link Sensor.id}. Returns `undefined`
 * when no sensor with that ID is registered.
 */
export function findSensor(id: string): Sensor | undefined {
  return sensors.get(id);
}

/**
 * Remove a sensor by ID. Returns `true` if a sensor was removed,
 * `false` when the ID was unknown. Does not call `sensor.stop()` —
 * the caller (typically the EvolutionRuntime) owns lifecycle.
 */
export function unregisterSensor(id: string): boolean {
  return sensors.delete(id);
}

/**
 * Reset the registry. Intended for tests; production code should never
 * need to clear the slot.
 */
export function clearSensors(): void {
  sensors.clear();
}
