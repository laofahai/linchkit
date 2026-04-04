import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createCacheCheck,
  createDatabaseCheck,
  createEventBusCheck,
  createEntityCheck,
  detectEnvironment,
  GracefulShutdownManager,
  HealthCheckRegistry,
  livenessCheck,
  validateRequiredEnvVars,
} from "../src/deployment";

// ── Test helpers ────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── HealthCheckRegistry ─────────────────────────────────────

describe("HealthCheckRegistry", () => {
  let registry: HealthCheckRegistry;

  beforeEach(() => {
    registry = new HealthCheckRegistry({ checkTimeoutMs: 500 });
  });

  it("returns healthy when no checks registered", async () => {
    const result = await registry.runAll();
    expect(result.status).toBe("healthy");
    expect(result.checks).toHaveLength(0);
    expect(result.timestamp).toBeTruthy();
  });

  it("registers and runs a simple check", async () => {
    registry.register("test", () => ({
      name: "test",
      status: "healthy",
      durationMs: 0,
    }));

    expect(registry.list()).toEqual(["test"]);
    const result = await registry.runAll();
    expect(result.status).toBe("healthy");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.name).toBe("test");
  });

  it("aggregates to degraded when one check is degraded", async () => {
    registry.register("ok", () => ({
      name: "ok",
      status: "healthy",
      durationMs: 0,
    }));
    registry.register("slow", () => ({
      name: "slow",
      status: "degraded",
      message: "Slow response",
      durationMs: 100,
    }));

    const result = await registry.runAll();
    expect(result.status).toBe("degraded");
  });

  it("aggregates to unhealthy when one check is unhealthy", async () => {
    registry.register("ok", () => ({
      name: "ok",
      status: "healthy",
      durationMs: 0,
    }));
    registry.register("broken", () => ({
      name: "broken",
      status: "unhealthy",
      message: "Connection refused",
      durationMs: 0,
    }));

    const result = await registry.runAll();
    expect(result.status).toBe("unhealthy");
  });

  it("handles async checks", async () => {
    registry.register("async", async () => {
      await sleep(10);
      return { name: "async", status: "healthy", durationMs: 10 };
    });

    const result = await registry.runAll();
    expect(result.status).toBe("healthy");
    expect(result.checks[0]?.name).toBe("async");
  });

  it("handles check timeout", async () => {
    registry.register("slow", async () => {
      await sleep(2000);
      return { name: "slow", status: "healthy", durationMs: 2000 };
    });

    const result = await registry.runAll();
    expect(result.status).toBe("unhealthy");
    expect(result.checks[0]?.message).toContain("timed out");
  });

  it("handles check that throws", async () => {
    registry.register("error", () => {
      throw new Error("Unexpected failure");
    });

    const result = await registry.runAll();
    expect(result.status).toBe("unhealthy");
    expect(result.checks[0]?.message).toContain("Unexpected failure");
  });

  it("runs a single named check", async () => {
    registry.register("db", () => ({
      name: "db",
      status: "healthy",
      durationMs: 1,
    }));

    const result = await registry.run("db");
    expect(result.status).toBe("healthy");
  });

  it("returns unhealthy for unknown check name", async () => {
    const result = await registry.run("nonexistent");
    expect(result.status).toBe("unhealthy");
    expect(result.message).toContain("not registered");
  });

  it("unregisters a check", () => {
    registry.register("temp", () => ({
      name: "temp",
      status: "healthy",
      durationMs: 0,
    }));
    expect(registry.list()).toContain("temp");

    registry.unregister("temp");
    expect(registry.list()).not.toContain("temp");
  });
});

// ── Built-in checks ─────────────────────────────────────────

describe("livenessCheck", () => {
  it("returns healthy with pid and uptime", () => {
    const result = livenessCheck();
    expect(result.status).toBe("healthy");
    expect(result.name).toBe("liveness");
    expect(result.metadata?.pid).toBe(process.pid);
    expect(typeof result.metadata?.uptime).toBe("number");
  });
});

describe("createDatabaseCheck", () => {
  it("returns healthy when DB check succeeds", async () => {
    const check = createDatabaseCheck(async () => true);
    const result = await check();
    expect(result.status).toBe("healthy");
    expect(result.name).toBe("database");
  });

  it("returns unhealthy when DB check throws", async () => {
    const check = createDatabaseCheck(async () => {
      throw new Error("Connection refused");
    });
    const result = await check();
    expect(result.status).toBe("unhealthy");
    expect(result.message).toContain("Connection refused");
  });
});

describe("createEntityCheck", () => {
  it("returns healthy when schemas are loaded", () => {
    const check = createEntityCheck(() => 5);
    const result = check();
    expect(result.status).toBe("healthy");
    expect(result.metadata?.schemaCount).toBe(5);
  });

  it("returns degraded when no schemas loaded", () => {
    const check = createEntityCheck(() => 0);
    const result = check();
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("No schemas");
  });
});

describe("createEventBusCheck", () => {
  it("returns healthy when listeners are active", () => {
    const check = createEventBusCheck(() => 3);
    const result = check();
    expect(result.status).toBe("healthy");
    expect(result.name).toBe("eventbus");
    expect(result.metadata?.listenerCount).toBe(3);
    expect(result.message).toContain("3 listener(s) active");
  });

  it("returns degraded when no listeners", () => {
    const check = createEventBusCheck(() => 0);
    const result = check();
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("No event listeners");
  });
});

describe("createCacheCheck", () => {
  it("returns healthy with cache stats", () => {
    const check = createCacheCheck(() => ({ hits: 42, misses: 8, size: 15 }));
    const result = check();
    expect(result.status).toBe("healthy");
    expect(result.name).toBe("cache");
    expect(result.metadata?.hits).toBe(42);
    expect(result.metadata?.misses).toBe(8);
    expect(result.metadata?.size).toBe(15);
    expect(result.message).toContain("15 entries");
  });
});

// ── GracefulShutdownManager ─────────────────────────────────

describe("GracefulShutdownManager", () => {
  it("executes hooks in priority order", async () => {
    const order: string[] = [];
    const manager = new GracefulShutdownManager({
      exitOnComplete: false,
      logger: silentLogger,
    });

    manager.register(
      "close-db",
      async () => {
        order.push("close-db");
      },
      90,
    );
    manager.register(
      "drain",
      async () => {
        order.push("drain");
      },
      10,
    );
    manager.register(
      "flush-events",
      async () => {
        order.push("flush-events");
      },
      50,
    );

    await manager.shutdown();

    expect(order).toEqual(["drain", "flush-events", "close-db"]);
    expect(manager.getStatus().phase).toBe("done");
    expect(manager.getStatus().completedHooks).toEqual(["drain", "flush-events", "close-db"]);
  });

  it("reports failed hooks", async () => {
    const manager = new GracefulShutdownManager({
      exitOnComplete: false,
      logger: silentLogger,
    });

    manager.register("ok", async () => {}, 10);
    manager.register(
      "fail",
      async () => {
        throw new Error("boom");
      },
      20,
    );
    manager.register("also-ok", async () => {}, 30);

    await manager.shutdown();

    const status = manager.getStatus();
    expect(status.phase).toBe("error");
    expect(status.completedHooks).toEqual(["ok", "also-ok"]);
    expect(status.failedHooks).toEqual(["fail"]);
  });

  it("is idempotent — concurrent calls return same promise", async () => {
    const calls: number[] = [];
    const manager = new GracefulShutdownManager({
      exitOnComplete: false,
      logger: silentLogger,
    });

    manager.register("track", async () => {
      await sleep(10);
      calls.push(1);
    });

    const [r1, r2] = await Promise.all([manager.shutdown(), manager.shutdown()]);
    expect(r1).toBe(r2);
    expect(calls).toHaveLength(1);
  });

  it("handles timeout — skips remaining hooks", async () => {
    const manager = new GracefulShutdownManager({
      exitOnComplete: false,
      timeoutMs: 50,
      logger: silentLogger,
    });

    manager.register(
      "slow",
      async () => {
        await sleep(200);
      },
      10,
    );
    manager.register("skipped", async () => {}, 20);

    await manager.shutdown();

    const status = manager.getStatus();
    // Either the slow hook times out (error) or the whole thing times out
    expect(status.phase).toBe("error");
  });

  it("unregisters hooks", async () => {
    const order: string[] = [];
    const manager = new GracefulShutdownManager({
      exitOnComplete: false,
      logger: silentLogger,
    });

    manager.register("a", async () => {
      order.push("a");
    });
    manager.register("b", async () => {
      order.push("b");
    });
    manager.unregister("a");

    await manager.shutdown();
    expect(order).toEqual(["b"]);
  });

  it("status is pending before shutdown", () => {
    const manager = new GracefulShutdownManager({
      exitOnComplete: false,
      logger: silentLogger,
    });
    expect(manager.getStatus().phase).toBe("pending");
    expect(manager.getStatus().startedAt).toBeNull();
  });
});

// ── Environment detection ───────────────────────────────────

describe("detectEnvironment", () => {
  const originalBunEnv = process.env.BUN_ENV;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    // Restore env vars
    if (originalBunEnv !== undefined) {
      process.env.BUN_ENV = originalBunEnv;
    } else {
      delete process.env.BUN_ENV;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it("detects explicit environment", () => {
    const config = detectEnvironment("production");
    expect(config.name).toBe("production");
    expect(config.isProduction).toBe(true);
    expect(config.isDevelopment).toBe(false);
    expect(config.features.strictValidation).toBe(true);
    expect(config.features.detailedErrors).toBe(false);
  });

  it("detects development environment", () => {
    const config = detectEnvironment("development");
    expect(config.name).toBe("development");
    expect(config.isDevelopment).toBe(true);
    expect(config.isProduction).toBe(false);
    expect(config.features.verboseLogging).toBe(true);
    expect(config.features.hotReload).toBe(true);
    expect(config.features.permissiveCors).toBe(true);
  });

  it("detects staging as production-like", () => {
    const config = detectEnvironment("staging");
    expect(config.name).toBe("staging");
    expect(config.isProduction).toBe(true);
    expect(config.features.strictValidation).toBe(true);
    expect(config.features.hotReload).toBe(false);
  });

  it("detects test environment", () => {
    const config = detectEnvironment("test");
    expect(config.name).toBe("test");
    expect(config.isTest).toBe(true);
    expect(config.features.verboseLogging).toBe(true);
    expect(config.features.detailedErrors).toBe(true);
    expect(config.features.hotReload).toBe(false);
  });

  it("reads from BUN_ENV first", () => {
    process.env.BUN_ENV = "production";
    process.env.NODE_ENV = "development";
    const config = detectEnvironment();
    expect(config.name).toBe("production");
  });

  it("falls back to NODE_ENV", () => {
    delete process.env.BUN_ENV;
    process.env.NODE_ENV = "staging";
    const config = detectEnvironment();
    expect(config.name).toBe("staging");
  });

  it("normalizes aliases", () => {
    process.env.BUN_ENV = "prod";
    const config = detectEnvironment();
    expect(config.name).toBe("production");
  });

  it("defaults to development", () => {
    delete process.env.BUN_ENV;
    delete process.env.NODE_ENV;
    const config = detectEnvironment();
    expect(config.name).toBe("development");
  });
});

describe("validateRequiredEnvVars", () => {
  it("returns valid when all vars present", () => {
    process.env.TEST_DEPLOY_VAR = "value";
    const result = validateRequiredEnvVars(["TEST_DEPLOY_VAR"]);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
    delete process.env.TEST_DEPLOY_VAR;
  });

  it("returns missing vars", () => {
    delete process.env.NONEXISTENT_VAR_1;
    delete process.env.NONEXISTENT_VAR_2;
    const result = validateRequiredEnvVars(["NONEXISTENT_VAR_1", "NONEXISTENT_VAR_2"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["NONEXISTENT_VAR_1", "NONEXISTENT_VAR_2"]);
  });

  it("treats empty string as missing", () => {
    process.env.EMPTY_VAR = "";
    const result = validateRequiredEnvVars(["EMPTY_VAR"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["EMPTY_VAR"]);
    delete process.env.EMPTY_VAR;
  });

  it("returns valid for empty required list", () => {
    const result = validateRequiredEnvVars([]);
    expect(result.valid).toBe(true);
  });
});
