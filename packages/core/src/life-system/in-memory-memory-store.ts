/**
 * InMemoryMemoryStore — in-process MemoryStore implementation for Spec 55 Memory layer.
 *
 * Suitable for development, testing, and zero-DB deployments.
 * Production deployments should use a persistent store (e.g. cap-memory-drizzle).
 */

import type { Baseline, MemoryStore, Signal } from "../types/life-system";

export class InMemoryMemoryStore implements MemoryStore {
  private signals: Signal[] = [];
  private baselines: Map<string, Baseline> = new Map();

  async recordSignal(signal: Signal): Promise<void> {
    this.signals.push(signal);
  }

  async getBaseline(schema: string, metric: string): Promise<Baseline | null> {
    return this.baselines.get(`${schema}:${metric}`) ?? null;
  }

  async updateBaseline(baseline: Baseline): Promise<void> {
    this.baselines.set(`${baseline.entity}:${baseline.metric}`, baseline);
  }

  /**
   * Query recorded signals with optional filtering.
   * Extension beyond MemoryStore interface — used internally by MemoryEngine.
   */
  async getSignals(opts?: { entity?: string; since?: Date; limit?: number }): Promise<Signal[]> {
    let result = this.signals;

    if (opts?.entity) {
      result = result.filter((s) => {
        const payload = s.payload as Record<string, unknown> | null;
        return payload?.entity === opts.entity || s.type === opts.entity;
      });
    }

    if (opts?.since) {
      const since = opts.since;
      result = result.filter((s) => s.timestamp >= since);
    }

    if (opts?.limit !== undefined) {
      result = result.slice(-opts.limit);
    }

    return result;
  }

  /** Returns total number of recorded signals. */
  get signalCount(): number {
    return this.signals.length;
  }

  /** Returns number of computed baselines. */
  get baselineCount(): number {
    return this.baselines.size;
  }
}
