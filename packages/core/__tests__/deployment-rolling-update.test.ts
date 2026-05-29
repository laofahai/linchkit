import { describe, expect, it } from "bun:test";
import type { DeployArtifact, NodeDeployClient } from "../src/deployment/rolling-update";
import {
  RollingUpdateCoordinator,
  type RollingUpdateCoordinatorConfig,
} from "../src/deployment/rolling-update";

// ── Helpers ────────────────────────────────────────────────────────────────

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ARTIFACT: DeployArtifact = {
  version: "1.2.3",
  buildPath: "/tmp/build/1.2.3",
  checksum: "abc123",
};

type MockOps = {
  distributeArtifact?: () => Promise<void>;
  startNewInstance?: () => Promise<void>;
  healthCheck?: () => Promise<boolean>;
  switchTraffic?: () => Promise<void>;
  stopOldInstance?: () => Promise<void>;
  rollback?: () => Promise<void>;
};

function makeNode(nodeId: string, ops: MockOps = {}): NodeDeployClient {
  return {
    nodeId,
    distributeArtifact: ops.distributeArtifact ?? (() => Promise.resolve()),
    startNewInstance: ops.startNewInstance ?? (() => Promise.resolve()),
    healthCheck: ops.healthCheck ?? (() => Promise.resolve(true)),
    switchTraffic: ops.switchTraffic ?? (() => Promise.resolve()),
    stopOldInstance: ops.stopOldInstance ?? (() => Promise.resolve()),
    rollback: ops.rollback ?? (() => Promise.resolve()),
  };
}

function makeCoordinator(
  nodes: NodeDeployClient[],
  overrides: Partial<RollingUpdateCoordinatorConfig> = {},
): RollingUpdateCoordinator {
  return new RollingUpdateCoordinator({
    nodes,
    logger: silentLogger,
    healthCheckRetryIntervalMs: 0, // no real delays in tests
    ...overrides,
  });
}

// ── Constructor ────────────────────────────────────────────────────────────

describe("RollingUpdateCoordinator — constructor", () => {
  it("throws when nodes array is empty", () => {
    expect(() => makeCoordinator([])).toThrow("at least one node");
  });

  it("accepts a single node", () => {
    expect(() => makeCoordinator([makeNode("n1")])).not.toThrow();
  });
});

// ── Successful deploys ─────────────────────────────────────────────────────

describe("RollingUpdateCoordinator — successful deploys", () => {
  it("returns success and all nodes done for a single node", async () => {
    const coord = makeCoordinator([makeNode("n1")]);
    const result = await coord.deploy(ARTIFACT);

    expect(result.success).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.deployedNodes).toEqual(["n1"]);
    expect(result.failedNode).toBeUndefined();
    expect(result.nodeStatuses[0].phase).toBe("done");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns success and all nodes done for three nodes", async () => {
    const coord = makeCoordinator([makeNode("n1"), makeNode("n2"), makeNode("n3")]);
    const result = await coord.deploy(ARTIFACT);

    expect(result.success).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.deployedNodes).toEqual(["n1", "n2", "n3"]);
    expect(result.nodeStatuses.map((s) => s.phase)).toEqual(["done", "done", "done"]);
  });

  it("calls all five deploy steps on each node", async () => {
    const calls: string[] = [];
    const node = makeNode("n1", {
      distributeArtifact: async () => {
        calls.push("distribute");
      },
      startNewInstance: async () => {
        calls.push("start");
      },
      healthCheck: async () => {
        calls.push("health");
        return true;
      },
      switchTraffic: async () => {
        calls.push("switch");
      },
      stopOldInstance: async () => {
        calls.push("stop");
      },
    });

    await makeCoordinator([node]).deploy(ARTIFACT);

    expect(calls).toEqual(["distribute", "start", "health", "switch", "stop"]);
  });

  it("passes the artifact to distributeArtifact", async () => {
    let received: DeployArtifact | undefined;
    const node = makeNode("n1", {
      distributeArtifact: async (a) => {
        received = a;
      },
    });

    await makeCoordinator([node]).deploy(ARTIFACT);

    expect(received).toEqual(ARTIFACT);
  });
});

// ── Failure on distribute ──────────────────────────────────────────────────

describe("RollingUpdateCoordinator — failure cases", () => {
  it("pauses on distribute failure and records no deployed nodes", async () => {
    const node = makeNode("n1", {
      distributeArtifact: async () => {
        throw new Error("SCP failed");
      },
    });

    const result = await makeCoordinator([node]).deploy(ARTIFACT);

    expect(result.success).toBe(false);
    expect(result.phase).toBe("paused-on-failure");
    expect(result.failedNode).toBe("n1");
    expect(result.deployedNodes).toEqual([]);
    expect(result.nodeStatuses[0].phase).toBe("failed");
    expect(result.nodeStatuses[0].error).toContain("distribute failed");
  });

  it("pauses on startNewInstance failure", async () => {
    const node = makeNode("n1", {
      startNewInstance: async () => {
        throw new Error("port in use");
      },
    });

    const result = await makeCoordinator([node]).deploy(ARTIFACT);

    expect(result.success).toBe(false);
    expect(result.nodeStatuses[0].error).toContain("start failed");
  });

  it("pauses on switchTraffic failure", async () => {
    const node = makeNode("n1", {
      switchTraffic: async () => {
        throw new Error("nginx error");
      },
    });

    const result = await makeCoordinator([node]).deploy(ARTIFACT);

    expect(result.success).toBe(false);
    expect(result.nodeStatuses[0].error).toContain("traffic switch failed");
  });

  it("pauses on stopOldInstance failure and includes node in deployedNodes (traffic already switched)", async () => {
    const node = makeNode("n1", {
      stopOldInstance: async () => {
        throw new Error("process not found");
      },
    });

    const result = await makeCoordinator([node]).deploy(ARTIFACT);

    expect(result.success).toBe(false);
    expect(result.nodeStatuses[0].error).toContain("stop old instance failed");
    // Traffic was switched before stopOldInstance — node must be in deployedNodes for rollback.
    expect(result.deployedNodes).toEqual(["n1"]);
    expect(result.failedNode).toBe("n1");
  });

  it("stops after second node fails; first node remains in deployedNodes", async () => {
    const nodes = [
      makeNode("n1"),
      makeNode("n2", {
        distributeArtifact: async () => {
          throw new Error("disk full");
        },
      }),
      makeNode("n3"),
    ];

    const result = await makeCoordinator(nodes).deploy(ARTIFACT);

    expect(result.success).toBe(false);
    expect(result.phase).toBe("paused-on-failure");
    expect(result.failedNode).toBe("n2");
    expect(result.deployedNodes).toEqual(["n1"]);
    expect(result.nodeStatuses[0].phase).toBe("done");
    expect(result.nodeStatuses[1].phase).toBe("failed");
    expect(result.nodeStatuses[2].phase).toBe("pending"); // never reached
  });
});

// ── Health check retries ───────────────────────────────────────────────────

describe("RollingUpdateCoordinator — health check retries", () => {
  it("succeeds when health check passes on the second attempt", async () => {
    let attempt = 0;
    const node = makeNode("n1", {
      healthCheck: async () => {
        attempt++;
        return attempt >= 2;
      },
    });

    const result = await makeCoordinator([node], { healthCheckRetries: 3 }).deploy(ARTIFACT);

    expect(result.success).toBe(true);
    expect(attempt).toBe(2);
  });

  it("fails when health check never returns true within retry budget", async () => {
    const node = makeNode("n1", {
      healthCheck: async () => false,
    });

    const result = await makeCoordinator([node], { healthCheckRetries: 2 }).deploy(ARTIFACT);

    expect(result.success).toBe(false);
    expect(result.nodeStatuses[0].error).toContain("health check failed after 3 attempt(s)");
  });

  it("treats a thrown health check as unhealthy and retries", async () => {
    let attempt = 0;
    const node = makeNode("n1", {
      healthCheck: async () => {
        attempt++;
        if (attempt < 3) throw new Error("connection refused");
        return true;
      },
    });

    const result = await makeCoordinator([node], { healthCheckRetries: 3 }).deploy(ARTIFACT);

    expect(result.success).toBe(true);
    expect(attempt).toBe(3);
  });
});

// ── Rollback ──────────────────────────────────────────────────────────────

describe("RollingUpdateCoordinator — rollback", () => {
  it("rolls back deployed nodes in reverse order", async () => {
    const order: string[] = [];
    const nodes = [
      makeNode("n1", {
        rollback: async () => {
          order.push("n1");
        },
      }),
      makeNode("n2", {
        rollback: async () => {
          order.push("n2");
        },
      }),
      makeNode("n3", {
        rollback: async () => {
          order.push("n3");
        },
      }),
    ];

    const coord = makeCoordinator(nodes);
    const result = await coord.rollback(["n1", "n2", "n3"]);

    expect(result.success).toBe(true);
    expect(result.rolledBackNodes).toEqual(["n3", "n2", "n1"]);
    expect(order).toEqual(["n3", "n2", "n1"]);
    expect(result.failedRollbackNodes).toEqual([]);
  });

  it("skips nodes not in coordinator and continues", async () => {
    const node = makeNode("n1");
    const coord = makeCoordinator([node]);

    const result = await coord.rollback(["n1", "unknown-node"]);

    expect(result.success).toBe(true);
    expect(result.rolledBackNodes).toEqual(["n1"]);
  });

  it("records partial failure and returns success=false when one rollback throws", async () => {
    const nodes = [
      makeNode("n1", {
        rollback: async () => {
          throw new Error("no standby");
        },
      }),
      makeNode("n2"),
    ];

    const coord = makeCoordinator(nodes);
    const result = await coord.rollback(["n1", "n2"]);

    expect(result.success).toBe(false);
    expect(result.failedRollbackNodes).toContain("n1");
    expect(result.rolledBackNodes).toContain("n2");
    expect(result.error).toContain("n1");
  });

  it("returns success with empty lists when deployedNodeIds is empty", async () => {
    const coord = makeCoordinator([makeNode("n1")]);
    const result = await coord.rollback([]);

    expect(result.success).toBe(true);
    expect(result.rolledBackNodes).toEqual([]);
    expect(result.failedRollbackNodes).toEqual([]);
  });

  it("rollback after failed deploy only touches deployed nodes", async () => {
    const rollbackCalls: string[] = [];
    const nodes = [
      makeNode("n1", {
        rollback: async () => {
          rollbackCalls.push("n1");
        },
      }),
      makeNode("n2", {
        distributeArtifact: async () => {
          throw new Error("fail");
        },
        rollback: async () => {
          rollbackCalls.push("n2");
        },
      }),
    ];

    const coord = makeCoordinator(nodes);
    const deployResult = await coord.deploy(ARTIFACT);

    expect(deployResult.success).toBe(false);
    expect(deployResult.deployedNodes).toEqual(["n1"]);

    const rollbackResult = await coord.rollback(deployResult.deployedNodes);

    expect(rollbackResult.success).toBe(true);
    expect(rollbackCalls).toEqual(["n1"]); // n2 was never deployed
  });
});

// ── Result shape ──────────────────────────────────────────────────────────

describe("RollingUpdateCoordinator — result metadata", () => {
  it("durationMs is a non-negative number", async () => {
    const result = await makeCoordinator([makeNode("n1")]).deploy(ARTIFACT);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rollback durationMs is a non-negative number", async () => {
    const result = await makeCoordinator([makeNode("n1")]).rollback(["n1"]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
