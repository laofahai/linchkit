/**
 * Blue-Green Deployer — orchestrate blue-green instance switching (Spec 12 §4 steps 4-10).
 *
 * Starts the standby instance, health-checks it, switches Nginx upstream, then
 * gracefully drains and stops the old instance. All I/O operations are injectable
 * so the core logic is unit-testable without real processes or Nginx.
 */

import type { Logger } from "../types/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export type DeployPhase =
  | "idle"
  | "starting"
  | "health-checking"
  | "switching-nginx"
  | "draining"
  | "done"
  | "failed"
  | "rolling-back";

export interface ProcessHandle {
  readonly pid: number;
  kill(): Promise<void>;
}

/** Launch a new app process; return a handle to kill it later. */
export type ProcessLauncher = (
  command: string[],
  cwd: string,
  env?: Record<string, string>,
) => Promise<ProcessHandle>;

/** Fetch a URL for health probing; resolve to { status, ok }. Reject on network error. */
export type HttpFetcher = (
  url: string,
  timeoutMs: number,
) => Promise<{ status: number; ok: boolean }>;

/** Update the Nginx upstream to route traffic to `port`, then reload Nginx. */
export type NginxReloader = (port: number) => Promise<void>;

export interface BlueGreenConfig {
  /** Application start command (e.g. ["bun", "run", "start"]) */
  appCommand: string[];
  /** Working directory for the app */
  appCwd: string;
  /** Port for instance A */
  portA: number;
  /** Port for instance B */
  portB: number;
  /** Which port is initially active (default: portA) */
  initialActivePort?: number;
  /** Health check endpoint path (default: "/health") */
  healthCheckPath?: string;
  /** Timeout for a single health check request in ms (default: 5000) */
  healthCheckTimeoutMs?: number;
  /** Interval between health check retries in ms (default: 1000) */
  healthCheckIntervalMs?: number;
  /** Maximum health check attempts before giving up (default: 30) */
  healthCheckMaxRetries?: number;
  /** Time to wait for old instance to drain in-flight requests before killing it in ms (default: 30000) */
  gracefulShutdownWaitMs?: number;
  /** Optional extra env vars to set for the new instance */
  instanceEnv?: Record<string, string>;
  /** Injectable: launch a process and return a handle */
  processLauncher?: ProcessLauncher;
  /** Injectable: HTTP health probe */
  httpFetcher?: HttpFetcher;
  /** Injectable: update Nginx upstream config + reload; required */
  nginxReloader: NginxReloader;
  logger?: Logger;
}

export interface DeployResult {
  success: boolean;
  phase: DeployPhase;
  /** Port that is active after this operation */
  activePort: number;
  durationMs: number;
  error?: string;
}

// ── Default logger ───────────────────────────────────────────────────────────

const stdoutLogger: Logger = {
  debug: (msg, ctx) => console.debug(`[BlueGreenDeployer] ${msg}`, ctx ?? ""),
  info: (msg, ctx) => console.info(`[BlueGreenDeployer] ${msg}`, ctx ?? ""),
  warn: (msg, ctx) => console.warn(`[BlueGreenDeployer] ${msg}`, ctx ?? ""),
  error: (msg, ctx) => console.error(`[BlueGreenDeployer] ${msg}`, ctx ?? ""),
};

// ── BlueGreenDeployer ────────────────────────────────────────────────────────

export class BlueGreenDeployer {
  private readonly appCommand: string[];
  private readonly appCwd: string;
  private readonly portA: number;
  private readonly portB: number;
  private readonly healthCheckPath: string;
  private readonly healthCheckTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckMaxRetries: number;
  private readonly gracefulShutdownWaitMs: number;
  private readonly instanceEnv: Record<string, string>;
  private readonly processLauncher: ProcessLauncher;
  private readonly httpFetcher: HttpFetcher;
  private readonly nginxReloader: NginxReloader;
  private readonly logger: Logger;

  private _activePort: number;
  private _standbyPort: number;
  /** Handle to the most-recently deployed (now active) instance */
  private activeHandle: ProcessHandle | null = null;

  constructor(config: BlueGreenConfig) {
    if (config.portA === config.portB) {
      throw new Error(`portA and portB must be different, both are ${config.portA}`);
    }

    this.appCommand = config.appCommand;
    this.appCwd = config.appCwd;
    this.portA = config.portA;
    this.portB = config.portB;
    this.healthCheckPath = config.healthCheckPath ?? "/health";
    this.healthCheckTimeoutMs = config.healthCheckTimeoutMs ?? 5_000;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 1_000;
    this.healthCheckMaxRetries = config.healthCheckMaxRetries ?? 30;
    this.gracefulShutdownWaitMs = config.gracefulShutdownWaitMs ?? 30_000;
    this.instanceEnv = config.instanceEnv ?? {};
    this.processLauncher = config.processLauncher ?? defaultProcessLauncher;
    this.httpFetcher = config.httpFetcher ?? defaultHttpFetcher;
    this.nginxReloader = config.nginxReloader;
    this.logger = config.logger ?? stdoutLogger;

    const initialActive = config.initialActivePort ?? config.portA;
    if (initialActive !== config.portA && initialActive !== config.portB) {
      throw new Error(
        `initialActivePort must be portA (${config.portA}) or portB (${config.portB}), got ${initialActive}`,
      );
    }
    this._activePort = initialActive;
    this._standbyPort = initialActive === config.portA ? config.portB : config.portA;
  }

  /** Port currently serving traffic */
  get activePort(): number {
    return this._activePort;
  }

  /** Port standing by (will host the next deployment) */
  get standbyPort(): number {
    return this._standbyPort;
  }

  /**
   * Execute a blue-green deployment:
   * 1. Start new instance on the standby port
   * 2. Poll health check until healthy (or max retries exceeded)
   * 3. Switch Nginx upstream to the standby port
   * 4. Wait gracefulShutdownWaitMs for old instance to drain in-flight requests
   * 5. Kill the old instance
   * 6. Swap active/standby port tracking
   */
  async deploy(): Promise<DeployResult> {
    const startMs = Date.now();
    const elapsed = () => Date.now() - startMs;

    this.logger.info("BlueGreenDeployer: starting deployment", {
      activePort: this._activePort,
      standbyPort: this._standbyPort,
    });

    // ── Step 1: Start new instance on standby port ───────────────────────────
    this.logger.info("BlueGreenDeployer: starting standby instance", {
      port: this._standbyPort,
    });

    let newHandle: ProcessHandle;
    try {
      newHandle = await this.processLauncher(this.appCommand, this.appCwd, {
        ...this.instanceEnv,
        PORT: String(this._standbyPort),
      });
      this.logger.info("BlueGreenDeployer: standby instance started", {
        pid: newHandle.pid,
        port: this._standbyPort,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("BlueGreenDeployer: failed to start standby instance", { error: msg });
      return {
        success: false,
        phase: "failed",
        activePort: this._activePort,
        durationMs: elapsed(),
        error: `Failed to start standby instance: ${msg}`,
      };
    }

    // ── Step 2: Health check standby instance ────────────────────────────────
    this.logger.info("BlueGreenDeployer: polling health check", {
      port: this._standbyPort,
      maxRetries: this.healthCheckMaxRetries,
    });

    const healthy = await this.pollHealthCheck(this._standbyPort);
    if (!healthy) {
      this.logger.error("BlueGreenDeployer: standby instance failed health checks");
      await this.killSilent(newHandle, `standby (port ${this._standbyPort}, failed health check)`);
      return {
        success: false,
        phase: "failed",
        activePort: this._activePort,
        durationMs: elapsed(),
        error: `Standby instance on port ${this._standbyPort} failed health checks after ${this.healthCheckMaxRetries} retries`,
      };
    }

    this.logger.info("BlueGreenDeployer: standby instance is healthy, switching Nginx upstream");

    // ── Step 3: Switch Nginx upstream ────────────────────────────────────────
    try {
      await this.nginxReloader(this._standbyPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("BlueGreenDeployer: Nginx reload failed; killing standby", { error: msg });
      await this.killSilent(newHandle, `standby (port ${this._standbyPort}, nginx reload failed)`);
      return {
        success: false,
        phase: "failed",
        activePort: this._activePort,
        durationMs: elapsed(),
        error: `Nginx reload failed: ${msg}`,
      };
    }

    // ── Step 4+5: Drain old instance then kill it ────────────────────────────
    const prevHandle = this.activeHandle;
    const prevPort = this._activePort;

    // Swap tracking before the async drain so activePort is correct if caller
    // inspects state during the drain window.
    this._activePort = this._standbyPort;
    this._standbyPort = prevPort;
    this.activeHandle = newHandle;

    this.logger.info("BlueGreenDeployer: Nginx switched; traffic on port", {
      activePort: this._activePort,
    });

    if (prevHandle) {
      if (this.gracefulShutdownWaitMs > 0) {
        this.logger.info("BlueGreenDeployer: waiting for old instance to drain", {
          waitMs: this.gracefulShutdownWaitMs,
          port: prevPort,
        });
        await sleep(this.gracefulShutdownWaitMs);
      }
      await this.killSilent(prevHandle, `old active (port ${prevPort})`);
    } else {
      this.logger.info("BlueGreenDeployer: no tracked previous instance to drain (first deploy)");
    }

    this.logger.info("BlueGreenDeployer: deployment complete", {
      activePort: this._activePort,
      durationMs: elapsed(),
    });

    return {
      success: true,
      phase: "done",
      activePort: this._activePort,
      durationMs: elapsed(),
    };
  }

  /**
   * Quick rollback (Spec 12 §6) — switch Nginx back to the standby port (which was the
   * previous active instance). Safe to call even if no `deploy()` has been executed yet.
   */
  async rollback(): Promise<DeployResult> {
    const startMs = Date.now();
    const elapsed = () => Date.now() - startMs;

    this.logger.info("BlueGreenDeployer: rolling back", {
      currentActive: this._activePort,
      rollingBackTo: this._standbyPort,
    });

    try {
      await this.nginxReloader(this._standbyPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("BlueGreenDeployer: rollback Nginx reload failed", { error: msg });
      return {
        success: false,
        phase: "rolling-back",
        activePort: this._activePort,
        durationMs: elapsed(),
        error: `Rollback Nginx reload failed: ${msg}`,
      };
    }

    // Kill the recently-deployed (now rolled-back-from) instance
    if (this.activeHandle) {
      await this.killSilent(this.activeHandle, `rolled-back instance (port ${this._activePort})`);
      this.activeHandle = null;
    }

    // Swap active/standby
    const prev = this._activePort;
    this._activePort = this._standbyPort;
    this._standbyPort = prev;

    this.logger.info("BlueGreenDeployer: rollback complete", { activePort: this._activePort });

    return {
      success: true,
      phase: "done",
      activePort: this._activePort,
      durationMs: elapsed(),
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async pollHealthCheck(port: number): Promise<boolean> {
    const url = `http://127.0.0.1:${port}${this.healthCheckPath}`;
    for (let attempt = 1; attempt <= this.healthCheckMaxRetries; attempt++) {
      try {
        const res = await this.httpFetcher(url, this.healthCheckTimeoutMs);
        if (res.ok) {
          this.logger.info("BlueGreenDeployer: health check passed", { port, attempt });
          return true;
        }
        this.logger.warn("BlueGreenDeployer: health check non-OK response", {
          port,
          status: res.status,
          attempt,
          maxRetries: this.healthCheckMaxRetries,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("BlueGreenDeployer: health check request error", {
          port,
          error: msg,
          attempt,
          maxRetries: this.healthCheckMaxRetries,
        });
      }

      if (attempt < this.healthCheckMaxRetries) {
        await sleep(this.healthCheckIntervalMs);
      }
    }
    return false;
  }

  private async killSilent(handle: ProcessHandle, label: string): Promise<void> {
    try {
      await handle.kill();
      this.logger.info(`BlueGreenDeployer: killed instance (${label})`, { pid: handle.pid });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`BlueGreenDeployer: could not kill instance (${label})`, {
        pid: handle.pid,
        error: msg,
      });
    }
  }
}

// ── Default implementations ──────────────────────────────────────────────────

const defaultProcessLauncher: ProcessLauncher = async (command, cwd, env) => {
  const [cmd, ...args] = command;
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    pid: proc.pid,
    kill: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
};

const defaultHttpFetcher: HttpFetcher = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { status: res.status, ok: res.ok };
  } finally {
    clearTimeout(timer);
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
