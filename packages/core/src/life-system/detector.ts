/**
 * Detector — abstract Awareness-layer contract (Spec 55 / Spec 56 Phase 2 Step 2c).
 *
 * A Detector consumes some input (logs, events, usage records, ...) and returns
 * a domain-specific output, or `null` when nothing is detected. Concrete
 * detection algorithms — pattern detection, anomaly detection, drift
 * detection, ... — live in capabilities (e.g. `cap-ai-provider`). Core only
 * keeps this minimal interface so engines and capabilities can wire detectors
 * through DI without coupling to specific implementations.
 *
 * Both sync and async implementations are supported: the return type is
 * `TOutput | null | Promise<TOutput | null>`. Implementations may throw on
 * malformed input but should prefer returning `null` for a "no signal"
 * outcome rather than treating it as an error.
 *
 * @typeParam TInput  Shape of data fed to the detector. Defaults to `unknown`
 *                    so the interface stays open.
 * @typeParam TOutput Shape of the detector's positive output. Defaults to
 *                    `unknown`. Detectors that emit arrays of findings can
 *                    parameterise `TOutput` with the array type.
 *
 * @see docs/specs/55_evolution_system.md (Awareness layer)
 * @see docs/specs/56_core_slimming.md (Phase 2 Step 2c)
 */
export interface Detector<TInput = unknown, TOutput = unknown> {
  /**
   * Stable identifier for this detector instance. Conventionally
   * `<capability>.<detector_name>` (e.g. `ai.pattern_detector`). Used by
   * registries / DI containers as a lookup key.
   */
  readonly id: string;

  /**
   * Run detection over `input`. Return the detector's positive output, or
   * `null` when nothing was detected. May return a Promise so detectors
   * needing I/O (DB lookups, model inference) do not have to block.
   */
  detect(input: TInput): Promise<TOutput | null> | TOutput | null;
}
