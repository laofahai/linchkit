import { describe, expect, it } from "bun:test";
import {
  createCacheCheck,
  createDatabaseCheck,
  createEventBusCheck,
  createSchemaCheck,
  HealthCheckRegistry,
  livenessCheck,
} from "../src/deployment/health-check";

// ── HealthCheckRegistry ──────────────────────────────────

describe("HealthCheckRegistry", () => {
  describe("register / unregister / list", () => {
    it("registers a health check and lists it", () => {
      const registry = new HealthCheckRegistry();
      registry.register("db", async () => ({
        name: "db",
        status: "healthy",
        durationMs: 0,
      }));
      expect(registry.list()).toContain("db");
    });

    it("unregisters a health check", () => {
      const registry = new HealthCheckRegistry();
      registry.register("db", async () => ({ name: "db", status: "healthy", durationMs: 0 }));
      registry.unregister("db");
      expect(registry.list()).not.toContain("db");
    });

    it("lists empty when no checks registered", () => {
      const registry = new HealthCheckRegistry();
      expect(registry.list()).toHaveLength(0);
    });
  });

  describe("runAll", () => {
    it("returns healthy when no checks registered", async () => {
      const registry = new HealthCheckRegistry();
      const result = await registry.runAll();
      expect(result.status).toBe("healthy");
      expect(result.checks).toHaveLength(0);
      expect(result.timestamp).toBeTruthy();
    });

    it("aggregates all healthy checks to healthy", async () => {
      const registry = new HealthCheckRegistry();
      registry.register("a", () => ({ name: "a", status: "healthy", durationMs: 0 }));
      registry.register("b", () => ({ name: "b", status: "healthy", durationMs: 0 }));
      const result = await registry.runAll();
      expect(result.status).toBe("healthy");
      expect(result.checks).toHaveLength(2);
    });

    it("aggregates to degraded when any check is degraded", async () => {
      const registry = new HealthCheckRegistry();
      registry.register("a", () => ({ name: "a", status: "healthy", durationMs: 0 }));
      registry.register("b", () => ({ name: "b", status: "degraded", durationMs: 0 }));
      const result = await registry.runAll();
      expect(result.status).toBe("degraded");
    });

    it("aggregates to unhealthy when any check is unhealthy", async () => {
      const registry = new HealthCheckRegistry();
      registry.register("a", () => ({ name: "a", status: "degraded", durationMs: 0 }));
      registry.register("b", () => ({ name: "b", status: "unhealthy", durationMs: 0 }));
      const result = await registry.runAll();
      expect(result.status).toBe("unhealthy");
    });

    it("handles async checks", async () => {
      const registry = new HealthCheckRegistry();
      registry.register("async_check", async () => {
        await Promise.resolve();
        return { name: "async_check", status: "healthy", durationMs: 1 };
      });
      const result = await registry.runAll();
      expect(result.status).toBe("healthy");
    });

    it("marks check as unhealthy if it throws", async () => {
      const registry = new HealthCheckRegistry();
      registry.register("failing", async () => {
        throw new Error("DB exploded");
      });
      const result = await registry.runAll();
      expect(result.status).toBe("unhealthy");
      expect(result.checks[0].status).toBe("unhealthy");
      expect(result.checks[0].message).toContain("DB exploded");
    });
  });

  describe("run (single check)", () => {
    it("runs a named check successfully", async () => {
      const registry = new HealthCheckRegistry();
      registry.register("ping", () => ({ name: "ping", status: "healthy", durationMs: 0 }));
      const result = await registry.run("ping");
      expect(result.status).toBe("healthy");
    });

    it("returns unhealthy for unknown check name", async () => {
      const registry = new HealthCheckRegistry();
      const result = await registry.run("nonexistent");
      expect(result.status).toBe("unhealthy");
      expect(result.message).toContain("not registered");
    });
  });

  describe("timeout handling", () => {
    it("returns unhealthy when check exceeds timeout", async () => {
      const registry = new HealthCheckRegistry({ checkTimeoutMs: 50 });
      registry.register("slow", async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { name: "slow", status: "healthy", durationMs: 200 };
      });
      const result = await registry.run("slow");
      expect(result.status).toBe("unhealthy");
      expect(result.message).toContain("timed out");
    });
  });
});

// ── Built-in check factories ──────────────────────────────

describe("livenessCheck", () => {
  it("always returns healthy", () => {
    const result = livenessCheck();
    expect(result.status).toBe("healthy");
    expect(result.name).toBe("liveness");
    expect(result.metadata?.pid).toBeTruthy();
  });
});

describe("createDatabaseCheck", () => {
  it("returns healthy when DB check succeeds", async () => {
    const check = createDatabaseCheck(async () => true);
    const result = await check();
    expect(result.status).toBe("healthy");
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

describe("createSchemaCheck", () => {
  it("returns healthy when schemas are loaded", () => {
    const check = createSchemaCheck(() => 5);
    const result = check() as ReturnType<typeof livenessCheck>;
    expect(result.status).toBe("healthy");
    expect(result.metadata?.schemaCount).toBe(5);
  });

  it("returns degraded when no schemas are loaded", () => {
    const check = createSchemaCheck(() => 0);
    const result = check() as ReturnType<typeof livenessCheck>;
    expect(result.status).toBe("degraded");
  });
});

describe("createEventBusCheck", () => {
  it("returns healthy with active listeners", () => {
    const check = createEventBusCheck(() => 3);
    const result = check() as ReturnType<typeof livenessCheck>;
    expect(result.status).toBe("healthy");
    expect(result.metadata?.listenerCount).toBe(3);
  });

  it("returns degraded with no listeners", () => {
    const check = createEventBusCheck(() => 0);
    const result = check() as ReturnType<typeof livenessCheck>;
    expect(result.status).toBe("degraded");
  });
});

describe("createCacheCheck", () => {
  it("always returns healthy with stats", () => {
    const check = createCacheCheck(() => ({ hits: 10, misses: 2, size: 50 }));
    const result = check() as ReturnType<typeof livenessCheck>;
    expect(result.status).toBe("healthy");
    expect(result.metadata?.hits).toBe(10);
    expect(result.metadata?.size).toBe(50);
  });
});
