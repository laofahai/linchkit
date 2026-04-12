/**
 * EvolutionRuntime — composition root for the Spec 55 life-system.
 *
 * Wires the full pipeline in one call:
 *   SignalBus → MemoryEngine → AwarenessEngine → InsightEngine → EvolutionCycle
 *
 * Capabilities supply Sensors via `cap.extensions.sensors`. The CLI startup
 * flattens these into a `Sensor[]` (see `collectCapabilityDefinitions`) and
 * passes them to this factory, which registers each on the SignalBus.
 *
 * Without this factory the `extensions.sensors` field is dead config — sensors
 * defined by capabilities are never registered and never fire.
 */

import type { OntologyRegistry } from "../ontology/ontology-registry";
import type {
  AwarenessEngine,
  EvolutionCycle,
  InsightEngine,
  MemoryStore,
  Sensor,
  SensorContext,
} from "../types/life-system";
import { createAwarenessEngine } from "./awareness-engine";
import { createEvolutionCycle } from "./evolution-cycle";
import { InMemoryMemoryStore } from "./in-memory-memory-store";
import type { InsightEngineOptions } from "./insight-engine";
import type { MemoryEngineOptions } from "./memory-engine";
import { MemoryEngine } from "./memory-engine";
import type { SignalBus } from "./signal-bus";
import { createSignalBus } from "./signal-bus";

/** Bundle of life-system engines returned from `createEvolutionRuntime`. */
export interface EvolutionRuntime {
  signalBus: SignalBus;
  evolutionCycle: EvolutionCycle;
  insightEngine: InsightEngine;
  awarenessEngine: AwarenessEngine;
}

/** Construction options for {@link createEvolutionRuntime}. */
export interface EvolutionRuntimeOptions {
  /** Sensors collected from capabilities. Each is registered on the SignalBus. */
  sensors: Sensor[];
  /**
   * Optional query helper passed to sensors via {@link SensorContext} when
   * runCycle() is invoked without an explicit context. Sensors use this to
   * look up records (e.g. execution_log entries) without coupling to a
   * specific store implementation.
   */
  query?: SensorContext["query"];
  /**
   * Optional MemoryStore. Defaults to {@link InMemoryMemoryStore}, suitable
   * for development and tests. Production deployments should pass a
   * persistent store (e.g. cap-memory-drizzle).
   */
  memoryStore?: MemoryStore;
  /**
   * Ontology registry consumed by the AwarenessEngine for structural checks.
   * When omitted, an empty stub is used — runtime still functions; structural
   * checks simply yield no findings.
   */
  ontology?: OntologyRegistry;
  /** Override MemoryEngine tuning (sliding window, drift threshold). */
  memoryEngine?: Pick<MemoryEngineOptions, "windowSize" | "driftThreshold">;
  /** Override InsightEngine promotion config. */
  insightPromotion?: InsightEngineOptions["promotion"];
}

/** Empty OntologyRegistry stub for environments where no ontology is supplied. */
function createEmptyOntology(): OntologyRegistry {
  return {
    describe: () => undefined,
    listEntities: () => [],
    searchEntities: () => [],
    actionsFor: () => [],
    rulesFor: () => [],
    stateFor: () => undefined,
    viewsFor: () => [],
    flowsFor: () => [],
    handlersFor: () => [],
    relatedEntities: () => [],
    entitiesImplementing: () => [],
    toJSON: () => ({}),
    toMarkdown: () => "",
  };
}

/**
 * Build a fully-wired EvolutionRuntime and register all supplied sensors
 * on the SignalBus. The returned `evolutionCycle.runCycle()` will then
 * collect signals from those sensors on every invocation.
 *
 * If `opts.query` is supplied, it becomes the default `query` injected into
 * SensorContext when callers invoke `runCycle()` without an explicit context
 * (or with a context that omits `query`). Callers who pass a `query` on
 * their own context override the default.
 */
export function createEvolutionRuntime(opts: EvolutionRuntimeOptions): EvolutionRuntime {
  const signalBus = createSignalBus();
  const memoryStore = opts.memoryStore ?? new InMemoryMemoryStore();
  const memoryEngine = new MemoryEngine({
    store: memoryStore,
    windowSize: opts.memoryEngine?.windowSize,
    driftThreshold: opts.memoryEngine?.driftThreshold,
  });
  const awareness = createAwarenessEngine({
    ontology: opts.ontology ?? createEmptyOntology(),
  });
  const innerCycle = createEvolutionCycle({
    signalBus,
    memoryEngine,
    awareness,
    insightPromotion: opts.insightPromotion,
  });

  // Register sensors, guarding against duplicate names. SignalBus stores sensors
  // in a Map keyed by name, so registering two with the same name would silently
  // overwrite the first. Duplicates almost always indicate a capability
  // misconfiguration (e.g. two capabilities shipping sensors with clashing
  // names) and we want that to fail fast with a clear error.
  const registered = new Set<string>();
  for (const sensor of opts.sensors) {
    if (registered.has(sensor.name)) {
      throw new Error(
        `Duplicate sensor name "${sensor.name}" in createEvolutionRuntime opts.sensors. ` +
          `Sensor names must be unique across all capabilities.`,
      );
    }
    registered.add(sensor.name);
    signalBus.registerSensor(sensor);
  }

  // Wrap runCycle so a runtime-level default `query` is merged into any
  // context the caller supplies. Caller-supplied `query` always wins.
  const evolutionCycle: EvolutionCycle = {
    get insightEngine() {
      return innerCycle.insightEngine;
    },
    get awarenessEngine() {
      return innerCycle.awarenessEngine;
    },
    runCycle(ctx?: SensorContext) {
      // Spread the caller-supplied ctx so any future SensorContext fields
      // (trace IDs, user metadata, etc.) flow through automatically. Then
      // override timestamp with a default and query with the runtime default
      // iff the caller didn't supply its own.
      const merged: SensorContext = {
        ...(ctx ?? { timestamp: new Date() }),
        timestamp: ctx?.timestamp ?? new Date(),
        query: ctx?.query ?? opts.query,
      };
      return innerCycle.runCycle(merged);
    },
  };

  return {
    signalBus,
    evolutionCycle,
    insightEngine: innerCycle.insightEngine,
    awarenessEngine: awareness,
  };
}
