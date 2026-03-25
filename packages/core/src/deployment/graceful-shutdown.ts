/**
 * Graceful Shutdown Manager — Orderly shutdown with hook priority and timeout.
 *
 * Registers shutdown hooks that run in priority order when SIGTERM/SIGINT is received.
 * Lower priority numbers run first (e.g. drain connections before closing DB).
 * Used in blue-green deployments to ensure in-flight requests complete before switching.
 */

import type { Logger } from "../types/logger";
import { consoleLogger } from "../observability/console-logger";

// ── Types ────────────────────────────────────────────────

export type ShutdownPhase = "pending" | "draining" | "closing" | "done" | "error";

export interface ShutdownHook {
  /** Descriptive name for logging */
  name: string;
  /** Lower runs first. Default: 100. Recommended: 10=drain, 50=flush, 90=close DB */
  priority: number;
  /** The cleanup function to execute */
  fn: () => Promise<void> | void;
}

export interface ShutdownStatus {
  phase: ShutdownPhase;
  startedAt: Date | null;
  completedHooks: string[];
  failedHooks: string[];
}

export interface GracefulShutdownManagerOptions {
  /** Maximum time to wait for all hooks to complete (default: 30000ms) */
  timeoutMs?: number;
  /** Logger instance (default: consoleLogger) */
  logger?: Logger;
  /** Whether to call process.exit after shutdown (default: true) */
  exitOnComplete?: boolean;
  /** Exit code on successful shutdown (default: 0) */
  exitCode?: number;
}

// ── GracefulShutdownManager ──────────────────────────────

export class GracefulShutdownManager {
  private hooks: ShutdownHook[] = [];
  private status: ShutdownStatus = {
    phase: "pending",
    startedAt: null,
    completedHooks: [],
    failedHooks: [],
  };
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly exitOnComplete: boolean;
  private readonly exitCode: number;
  private signalsBound = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: GracefulShutdownManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = options.logger ?? consoleLogger;
    this.exitOnComplete = options.exitOnComplete ?? true;
    this.exitCode = options.exitCode ?? 0;
  }

  /** Register a shutdown hook with optional priority (lower = earlier) */
  register(name: string, fn: () => Promise<void> | void, priority = 100): void {
    this.hooks.push({ name, priority, fn });
  }

  /** Remove a registered hook by name */
  unregister(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
  }

  /** Get current shutdown status */
  getStatus(): ShutdownStatus {
    return { ...this.status, completedHooks: [...this.status.completedHooks], failedHooks: [...this.status.failedHooks] };
  }

  /** Bind SIGTERM and SIGINT handlers. Safe to call multiple times — only binds once. */
  bindSignals(): void {
    if (this.signalsBound) return;
    this.signalsBound = true;

    const handler = (signal: string) => {
      this.logger.info(`Received ${signal}, starting graceful shutdown...`);
      this.shutdown();
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }

  /**
   * Execute all shutdown hooks in priority order.
   * Idempotent — concurrent calls return the same promise.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = this.executeShutdown();
    return this.shutdownPromise;
  }

  private async executeShutdown(): Promise<void> {
    this.status.startedAt = new Date();
    this.status.phase = "draining";

    // Sort hooks by priority (ascending — lower runs first)
    const sorted = [...this.hooks].sort((a, b) => a.priority - b.priority);

    this.logger.info(`Graceful shutdown: ${sorted.length} hook(s) to execute`, {
      hooks: sorted.map((h) => `${h.name}(${h.priority})`),
      timeoutMs: this.timeoutMs,
    });

    const deadline = Date.now() + this.timeoutMs;
    let timedOut = false;

    for (const hook of sorted) {
      if (Date.now() >= deadline) {
        timedOut = true;
        this.logger.warn(`Shutdown timeout reached, skipping remaining hooks`);
        break;
      }

      this.status.phase = "closing";
      const remaining = deadline - Date.now();

      try {
        await Promise.race([
          Promise.resolve(hook.fn()),
          timeoutReject(remaining),
        ]);
        this.status.completedHooks.push(hook.name);
        this.logger.info(`Shutdown hook completed: ${hook.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.status.failedHooks.push(hook.name);
        this.logger.error(`Shutdown hook failed: ${hook.name} — ${msg}`);
      }
    }

    if (timedOut || this.status.failedHooks.length > 0) {
      this.status.phase = "error";
    } else {
      this.status.phase = "done";
    }

    const durationMs = Date.now() - this.status.startedAt.getTime();
    this.logger.info(`Graceful shutdown ${this.status.phase} in ${durationMs}ms`, {
      completed: this.status.completedHooks,
      failed: this.status.failedHooks,
    });

    if (this.exitOnComplete) {
      process.exit(this.status.phase === "done" ? this.exitCode : 1);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Shutdown hook timed out after ${ms}ms`)), ms);
  });
}
