/**
 * Rolling Update Coordinator — multi-node sequential deployment.
 *
 * Implements the "Multi-machine Rolling Update" described in Spec 12 §7.
 * The coordinator iterates nodes sequentially; on failure it stops and returns
 * the list of already-deployed nodes so the caller can decide whether to roll back.
 */

import type { Logger } from "../types/logger";

// ── Types ─────────────────────────────────────────────────────────────────

export interface DeployArtifact {
  version: string;
  buildPath: string;
  checksum?: string;
}

/**
 * Injectable interface representing one runtime node's deployment operations.
 * Implement this backed by SSH, REST, or any transport. Provide a mock in tests.
 */
export interface NodeDeployClient {
  readonly nodeId: string;
  distributeArtifact(artifact: DeployArtifact): Promise<void>;
  startNewInstance(): Promise<void>;
  healthCheck(): Promise<boolean>;
  switchTraffic(): Promise<void>;
  stopOldInstance(): Promise<void>;
  rollback(): Promise<void>;
}

export type NodePhase =
  | "pending"
  | "distributing"
  | "starting"
  | "health-checking"
  | "switching"
  | "stopping-old"
  | "done"
  | "failed"
  | "rolled-back";

export interface NodeDeployStatus {
  nodeId: string;
  phase: NodePhase;
  error?: string;
}

export type RollingUpdatePhase = "idle" | "running" | "paused-on-failure" | "done" | "failed";

export interface RollingUpdateResult {
  success: boolean;
  phase: RollingUpdatePhase;
  /** Node IDs that completed all five deploy steps */
  deployedNodes: string[];
  /** Node ID that caused a failure, if any */
  failedNode?: string;
  nodeStatuses: NodeDeployStatus[];
  durationMs: number;
  error?: string;
}

export interface RollingUpdateRollbackResult {
  success: boolean;
  rolledBackNodes: string[];
  failedRollbackNodes: string[];
  durationMs: number;
  error?: string;
}

export interface RollingUpdateCoordinatorConfig {
  nodes: NodeDeployClient[];
  /** ms to wait before starting each subsequent node's cycle (default: 0) */
  nodeIntervalMs?: number;
  /** Retry count for health check after first failure (default: 3) */
  healthCheckRetries?: number;
  /** ms between health check retries (default: 1000) */
  healthCheckRetryIntervalMs?: number;
  logger?: Logger;
}

// ── RollingUpdateCoordinator ──────────────────────────────────────────────

export class RollingUpdateCoordinator {
  private readonly nodes: NodeDeployClient[];
  private readonly nodeIntervalMs: number;
  private readonly healthCheckRetries: number;
  private readonly healthCheckRetryIntervalMs: number;
  private readonly logger: Logger;

  constructor(config: RollingUpdateCoordinatorConfig) {
    if (config.nodes.length === 0) {
      throw new Error("RollingUpdateCoordinator requires at least one node");
    }
    this.nodes = config.nodes;
    this.nodeIntervalMs = config.nodeIntervalMs ?? 0;
    this.healthCheckRetries = config.healthCheckRetries ?? 3;
    this.healthCheckRetryIntervalMs = config.healthCheckRetryIntervalMs ?? 1_000;
    this.logger = config.logger ?? defaultLogger;
  }

  /**
   * Deploy artifact to all nodes sequentially (Spec 12 §7 steps 3–4).
   * Stops on first node failure and returns `phase: "paused-on-failure"` with
   * `deployedNodes` populated so the caller can invoke `rollback()`.
   */
  async deploy(artifact: DeployArtifact): Promise<RollingUpdateResult> {
    const startMs = Date.now();
    const nodeStatuses: NodeDeployStatus[] = this.nodes.map((n) => ({
      nodeId: n.nodeId,
      phase: "pending" as NodePhase,
    }));
    const deployedNodes: string[] = [];

    this.logger.info("RollingUpdateCoordinator: starting rolling deploy", {
      version: artifact.version,
      nodeCount: this.nodes.length,
    });

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const status = nodeStatuses[i];

      if (i > 0 && this.nodeIntervalMs > 0) {
        await delay(this.nodeIntervalMs);
      }

      this.logger.info("RollingUpdateCoordinator: deploying node", {
        nodeId: node.nodeId,
        index: i + 1,
        total: this.nodes.length,
      });

      const outcome = await this.deployNode(node, artifact, status);

      if (!outcome.success) {
        this.logger.error("RollingUpdateCoordinator: node failed — pausing", {
          nodeId: node.nodeId,
          error: outcome.error,
        });
        return {
          success: false,
          phase: "paused-on-failure",
          deployedNodes,
          failedNode: node.nodeId,
          nodeStatuses,
          durationMs: Date.now() - startMs,
          error: outcome.error,
        };
      }

      deployedNodes.push(node.nodeId);
      this.logger.info("RollingUpdateCoordinator: node done", { nodeId: node.nodeId });
    }

    this.logger.info("RollingUpdateCoordinator: rolling deploy complete", {
      version: artifact.version,
      nodes: deployedNodes.length,
      durationMs: Date.now() - startMs,
    });

    return {
      success: true,
      phase: "done",
      deployedNodes,
      nodeStatuses,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Roll back already-deployed nodes in reverse order (Spec 12 §6 / §7 step 5).
   * Caller passes `deployedNodes` from a failed deploy result.
   * Nodes that were never fully deployed are skipped.
   */
  async rollback(deployedNodeIds: string[]): Promise<RollingUpdateRollbackResult> {
    const startMs = Date.now();
    const nodeMap = new Map(this.nodes.map((n) => [n.nodeId, n]));
    const rolledBackNodes: string[] = [];
    const failedRollbackNodes: string[] = [];

    this.logger.info("RollingUpdateCoordinator: starting rollback", {
      nodeCount: deployedNodeIds.length,
    });

    // Reverse order: most recently deployed node first
    for (const nodeId of [...deployedNodeIds].reverse()) {
      const node = nodeMap.get(nodeId);
      if (!node) {
        this.logger.warn("RollingUpdateCoordinator: unknown nodeId in rollback, skipping", {
          nodeId,
        });
        continue;
      }

      try {
        await node.rollback();
        rolledBackNodes.push(nodeId);
        this.logger.info("RollingUpdateCoordinator: node rolled back", { nodeId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failedRollbackNodes.push(nodeId);
        this.logger.error("RollingUpdateCoordinator: node rollback failed", {
          nodeId,
          error: msg,
        });
      }
    }

    const success = failedRollbackNodes.length === 0;
    this.logger.info("RollingUpdateCoordinator: rollback complete", {
      success,
      rolledBack: rolledBackNodes.length,
      failed: failedRollbackNodes.length,
    });

    return {
      success,
      rolledBackNodes,
      failedRollbackNodes,
      durationMs: Date.now() - startMs,
      ...(success ? {} : { error: `Rollback failed for nodes: ${failedRollbackNodes.join(", ")}` }),
    };
  }

  // ── private ──────────────────────────────────────────────────────────────

  private async deployNode(
    node: NodeDeployClient,
    artifact: DeployArtifact,
    status: NodeDeployStatus,
  ): Promise<{ success: boolean; error?: string }> {
    // 1. Distribute artifact
    status.phase = "distributing";
    try {
      await node.distributeArtifact(artifact);
    } catch (err) {
      status.phase = "failed";
      status.error = `distribute failed: ${errorMsg(err)}`;
      return { success: false, error: status.error };
    }

    // 2. Start new instance
    status.phase = "starting";
    try {
      await node.startNewInstance();
    } catch (err) {
      status.phase = "failed";
      status.error = `start failed: ${errorMsg(err)}`;
      return { success: false, error: status.error };
    }

    // 3. Health check with retries
    status.phase = "health-checking";
    const healthy = await this.waitForHealthy(node);
    if (!healthy) {
      status.phase = "failed";
      status.error = `health check failed after ${this.healthCheckRetries + 1} attempt(s)`;
      return { success: false, error: status.error };
    }

    // 4. Switch traffic
    status.phase = "switching";
    try {
      await node.switchTraffic();
    } catch (err) {
      status.phase = "failed";
      status.error = `traffic switch failed: ${errorMsg(err)}`;
      return { success: false, error: status.error };
    }

    // 5. Stop old instance
    status.phase = "stopping-old";
    try {
      await node.stopOldInstance();
    } catch (err) {
      status.phase = "failed";
      status.error = `stop old instance failed: ${errorMsg(err)}`;
      return { success: false, error: status.error };
    }

    status.phase = "done";
    return { success: true };
  }

  private async waitForHealthy(node: NodeDeployClient): Promise<boolean> {
    for (let attempt = 0; attempt <= this.healthCheckRetries; attempt++) {
      if (attempt > 0 && this.healthCheckRetryIntervalMs > 0) {
        await delay(this.healthCheckRetryIntervalMs);
      }
      try {
        if (await node.healthCheck()) return true;
      } catch {
        // treat thrown errors as unhealthy — retry
      }
    }
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultLogger: Logger = {
  debug: (msg, ctx) => console.debug(`[RollingUpdate] ${msg}`, ctx ?? ""),
  info: (msg, ctx) => console.info(`[RollingUpdate] ${msg}`, ctx ?? ""),
  warn: (msg, ctx) => console.warn(`[RollingUpdate] ${msg}`, ctx ?? ""),
  error: (msg, ctx) => console.error(`[RollingUpdate] ${msg}`, ctx ?? ""),
};
