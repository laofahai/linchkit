/**
 * Sensor Registry — module-level slot for lifecycle-style sensors.
 *
 * Mirrors the pattern used by other extension slots in core
 * (see `doctor/doctor-registry.ts` for the canonical shape):
 * a module-level mutable registry plus a small set of pure helpers
 * (`registerSensor`, `getSensors`, `findSensor`, `unregisterSensor`,
 * `clearSensors`).
 *
 * Capabilities register their {@link LifecycleSensor} instances during
 * boot; the EvolutionRuntime reads the registered list and starts each
 * one. Detection-style sensors continue to flow through the
 * `extensions.sensors` slot on `CapabilityDefinition` and are NOT
 * managed by this registry.
 *
 * @see ./abstractions.ts for the {@link LifecycleSensor} interface itself
 * @see docs/specs/55_evolution_system.md §3.3
 * @see docs/specs/56_core_slimming.md (Phase 2 Step 2a)
 */

import type { LifecycleSensor } from "./abstractions";

// ── Internal state ─────────────────────────────────────────────────────────

/**
 * Module-level Map keyed by {@link LifecycleSensor.id}. Using a Map (not an
 * array) so `registerSensor` can fail fast on duplicate IDs and `findSensor`
 * is O(1).
 */
const sensors = new Map<string, LifecycleSensor>();

// ── Slot helpers ───────────────────────────────────────────────────────────

/**
 * Register a {@link LifecycleSensor} into the lifecycle-sensor registry.
 *
 * Throws if a sensor with the same `id` is already registered. Sensor IDs
 * must be globally unique because the EvolutionRuntime uses them as the
 * primary key for lifecycle management — silently overwriting would orphan
 * the previously-registered sensor's resources.
 */
export function registerSensor(sensor: LifecycleSensor): void {
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
export function getSensors(): LifecycleSensor[] {
  return Array.from(sensors.values());
}

/**
 * Look up a single sensor by its {@link LifecycleSensor.id}. Returns
 * `undefined` when no sensor with that ID is registered.
 */
export function findSensor(id: string): LifecycleSensor | undefined {
  return sensors.get(id);
}

/**
 * Remove a sensor by ID. Returns `true` if a sensor was removed,
 * `false` when the ID was unknown.
 *
 * Awaits `sensor.stop()` before removing the entry so that any timers,
 * sockets, or listeners held by a started sensor are released. If
 * `stop()` rejects, the error is swallowed and removal still proceeds —
 * the caller asked to unregister, and leaving a half-stopped sensor in
 * the registry would only compound the failure. Stop failures should be
 * surfaced via telemetry / Signals in a future revision.
 */
export async function unregisterSensor(id: string): Promise<boolean> {
  const sensor = sensors.get(id);
  if (!sensor) return false;
  try {
    await sensor.stop();
  } catch {
    // Swallow — removal must still happen. Future: emit a Signal or
    // telemetry event so operators can investigate stop failures.
  }
  return sensors.delete(id);
}

/**
 * Reset the registry. Intended for tests; production code should never
 * need to clear the slot.
 *
 * Awaits `sensor.stop()` for every registered sensor before clearing
 * the underlying map, mirroring {@link unregisterSensor}'s contract:
 * stop failures are swallowed so a single misbehaving sensor cannot
 * keep the registry in a half-cleared state.
 *
 * @internal Test-only helper. Not part of the public `@linchkit/core`
 * root export — tests import this directly from the module path
 * (`@linchkit/core/...sensor-registry`) or via the life-system barrel.
 */
export async function clearSensors(): Promise<void> {
  await Promise.all(
    Array.from(sensors.values()).map(async (sensor) => {
      try {
        await sensor.stop();
      } catch {
        // Swallow — same rationale as unregisterSensor.
      }
    }),
  );
  sensors.clear();
}
