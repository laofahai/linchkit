/**
 * Health Check Registry — Liveness and Readiness probe utilities.
 *
 * Provides a standardized health check mechanism for blue-green deployments.
 * Health checks are registered by name and executed on demand.
 * Results follow a standard format consumable by load balancers and orchestrators.
 */

// ── Types ────────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  /** Human-readable message (optional) */
  message?: string;
  /** Duration of the check in milliseconds */
  durationMs: number;
  /** Arbitrary metadata from the check */
  metadata?: Record<string, unknown>;
}

export interface AggregatedHealthStatus {
  status: HealthStatus;
  checks: HealthCheckResult[];
  /** Total time taken for all checks */
  totalDurationMs: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

export type HealthCheckFn = () => Promise<HealthCheckResult> | HealthCheckResult;

export interface HealthCheckRegistryOptions {
  /** Global timeout per individual check in milliseconds (default: 5000) */
  checkTimeoutMs?: number;
}

// ── HealthCheckRegistry ──────────────────────────────────

export class HealthCheckRegistry {
  private checks = new Map<string, HealthCheckFn>();
  private readonly checkTimeoutMs: number;

  constructor(options: HealthCheckRegistryOptions = {}) {
    this.checkTimeoutMs = options.checkTimeoutMs ?? 5000;
  }

  /** Register a named health check function */
  register(name: string, fn: HealthCheckFn): void {
    this.checks.set(name, fn);
  }

  /** Remove a named health check */
  unregister(name: string): void {
    this.checks.delete(name);
  }

  /** List registered check names */
  list(): string[] {
    return Array.from(this.checks.keys());
  }

  /** Run all registered checks and return aggregated status */
  async runAll(): Promise<AggregatedHealthStatus> {
    const start = Date.now();
    const results: HealthCheckResult[] = [];

    for (const [name, fn] of this.checks) {
      results.push(await this.runSingle(name, fn));
    }

    const totalDurationMs = Date.now() - start;
    const status = aggregateStatus(results);

    return {
      status,
      checks: results,
      totalDurationMs,
      timestamp: new Date().toISOString(),
    };
  }

  /** Run a single named check */
  async run(name: string): Promise<HealthCheckResult> {
    const fn = this.checks.get(name);
    if (!fn) {
      return {
        name,
        status: "unhealthy",
        message: `Health check "${name}" is not registered`,
        durationMs: 0,
      };
    }
    return this.runSingle(name, fn);
  }

  private async runSingle(name: string, fn: HealthCheckFn): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        Promise.resolve(fn()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`Health check "${name}" timed out after ${this.checkTimeoutMs}ms`)),
            this.checkTimeoutMs,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        name,
        status: "unhealthy",
        message: msg,
        durationMs: Date.now() - start,
      };
    }
  }
}

// ── Built-in checks ──────────────────────────────────────

/** Liveness check — always healthy if the process is running */
export function livenessCheck(): HealthCheckResult {
  return {
    name: "liveness",
    status: "healthy",
    message: "Process is alive",
    durationMs: 0,
    metadata: {
      pid: process.pid,
      uptime: process.uptime(),
    },
  };
}

/**
 * Create a database readiness check function.
 *
 * @param checkFn - A function that tests DB connectivity (e.g. `SELECT 1`).
 *   Should resolve to true if healthy, throw on failure.
 */
export function createDatabaseCheck(checkFn: () => Promise<boolean>): HealthCheckFn {
  return async (): Promise<HealthCheckResult> => {
    const start = Date.now();
    try {
      await checkFn();
      return {
        name: "database",
        status: "healthy",
        message: "Database connection is healthy",
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        name: "database",
        status: "unhealthy",
        message: `Database check failed: ${msg}`,
        durationMs: Date.now() - start,
      };
    }
  };
}

/**
 * Create a schema-loaded readiness check.
 *
 * @param getSchemaCount - Returns the number of loaded schemas.
 */
export function createSchemaCheck(getSchemaCount: () => number): HealthCheckFn {
  return (): HealthCheckResult => {
    const count = getSchemaCount();
    return {
      name: "schemas",
      status: count > 0 ? "healthy" : "degraded",
      message: count > 0 ? `${count} schema(s) loaded` : "No schemas loaded",
      durationMs: 0,
      metadata: { schemaCount: count },
    };
  };
}

// ── Helpers ──────────────────────────────────────────────

function aggregateStatus(results: HealthCheckResult[]): HealthStatus {
  if (results.length === 0) return "healthy";
  if (results.some((r) => r.status === "unhealthy")) return "unhealthy";
  if (results.some((r) => r.status === "degraded")) return "degraded";
  return "healthy";
}
