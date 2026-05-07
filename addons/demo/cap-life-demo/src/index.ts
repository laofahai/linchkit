/**
 * @linchkit/cap-life-demo — Spec 55 life-system end-to-end skeleton.
 *
 * Demonstrates the Sense -> Memory -> Awareness pipeline using only the
 * lifecycle abstractions added in PR #255 (LifecycleSensor,
 * LifecycleSignal, LifecycleBaseline, LifecycleMemoryStore).
 *
 * Intentionally tiny — no DB, no HTTP, no AI provider, no autoInstall.
 * Future capabilities can copy this wiring to bootstrap their own
 * lifecycle plumbing.
 *
 * @see ./pipeline.ts for the run() entry point.
 * @see docs/specs/55_evolution_system.md
 */

import { defineCapability } from "@linchkit/core";

export type { CountingBaselineOptions } from "./counting-baseline";
export { CountingBaseline } from "./counting-baseline";
export { InMemoryLifecycleStore } from "./in-memory-store";
export type { PipelineController, RunPipelineOptions } from "./pipeline";
export { run } from "./pipeline";
export type { PollSensorOptions } from "./poll-sensor";
export { PollSensor } from "./poll-sensor";

/**
 * Capability descriptor for the life-system skeleton demo.
 *
 * Empty by design — the demo is consumed via the `run()` API rather than
 * via any meta-model surface (no entities, no actions, no views). The
 * descriptor is published so the addon shows up in `linch validate` /
 * AGENTS.md and so future revisions have a canonical place to hang
 * sensors, automations, or views.
 */
export const capLifeDemo = defineCapability({
  name: "cap-life-demo",
  label: "Life-system Skeleton Demo",
  description:
    "Minimal Sense -> Memory pipeline skeleton wiring LifecycleSensor, " +
    "LifecycleMemoryStore and LifecycleBaseline (Spec 55).",
  type: "standard",
  category: "system",
  version: "0.0.1",
});
