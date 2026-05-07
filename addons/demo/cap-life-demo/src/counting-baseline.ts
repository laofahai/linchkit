/**
 * Tiny LifecycleBaseline that flags spikes in a stream of numeric values.
 *
 * Tracks the running mean and a moving max over the observations seen so
 * far. `score()` returns 1.0 when an observation exceeds
 * `mean * spikeMultiplier` (clamped to [0, 1]); otherwise the score
 * scales linearly between 0 and 1 across the band.
 *
 * Synchronous on every method — there's no I/O. Production baselines
 * (z-score, rolling EWMA, model-based) belong in their own capability;
 * this one exists to keep the demo readable.
 */

import type { LifecycleBaseline } from "@linchkit/core";

export interface CountingBaselineOptions {
  /** Stable identifier — typically `<entity>.<metric>`. */
  id: string;
  /** Multiplier above the running mean that counts as a full spike (score=1). Default: 5. */
  spikeMultiplier?: number;
  /** Minimum number of observations before scoring returns > 0. Default: 3. */
  warmup?: number;
}

interface Snapshot {
  id: string;
  count: number;
  mean: number;
  max: number;
  spikeMultiplier: number;
}

export class CountingBaseline implements LifecycleBaseline {
  readonly id: string;
  private readonly spikeMultiplier: number;
  private readonly warmup: number;
  private count = 0;
  private mean = 0;
  private max = 0;

  constructor(options: CountingBaselineOptions) {
    this.id = options.id;
    this.spikeMultiplier = options.spikeMultiplier ?? 5;
    this.warmup = options.warmup ?? 3;
  }

  update(observation: unknown): void {
    const value = this.toNumber(observation);
    if (value === null) return;
    this.count += 1;
    // Running mean: mean_n = mean_{n-1} + (x - mean_{n-1}) / n
    this.mean = this.mean + (value - this.mean) / this.count;
    if (value > this.max) this.max = value;
  }

  score(observation: unknown): number {
    const value = this.toNumber(observation);
    if (value === null) return 0;
    if (this.count < this.warmup) return 0;
    if (this.mean <= 0) return value > 0 ? 1 : 0;
    const ratio = value / (this.mean * this.spikeMultiplier);
    if (ratio <= 0) return 0;
    if (ratio >= 1) return 1;
    return ratio;
  }

  snapshot(): Snapshot {
    return {
      id: this.id,
      count: this.count,
      mean: this.mean,
      max: this.max,
      spikeMultiplier: this.spikeMultiplier,
    };
  }

  private toNumber(observation: unknown): number | null {
    if (typeof observation === "number" && Number.isFinite(observation)) return observation;
    if (typeof observation === "object" && observation !== null) {
      const candidate = (observation as { value?: unknown }).value;
      if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    }
    return null;
  }
}
