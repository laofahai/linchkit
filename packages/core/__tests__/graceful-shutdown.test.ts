import { describe, expect, it } from "bun:test";
import { GracefulShutdownManager } from "../src/deployment/graceful-shutdown";

// Silent logger for tests — no console noise
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ── GracefulShutdownManager ──────────────────────────────

describe("GracefulShutdownManager", () => {
  describe("register / unregister", () => {
    it("registers and lists hooks via getStatus", () => {
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register("server", async () => {}, 10);
      mgr.register("db", async () => {}, 90);
      const status = mgr.getStatus();
      expect(status.phase).toBe("pending");
    });

    it("unregisters a hook by name", async () => {
      const executed: string[] = [];
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register("server", async () => {
        executed.push("server");
      });
      mgr.register("db", async () => {
        executed.push("db");
      });
      mgr.unregister("server");
      await mgr.shutdown();
      expect(executed).not.toContain("server");
      expect(executed).toContain("db");
    });
  });

  describe("shutdown execution", () => {
    it("executes hooks in priority order (lower first)", async () => {
      const order: string[] = [];
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register(
        "db",
        async () => {
          order.push("db");
        },
        90,
      );
      mgr.register(
        "drain",
        async () => {
          order.push("drain");
        },
        10,
      );
      mgr.register(
        "flush",
        async () => {
          order.push("flush");
        },
        50,
      );
      await mgr.shutdown();
      expect(order).toEqual(["drain", "flush", "db"]);
    });

    it("sets phase to done on successful shutdown", async () => {
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register("noop", async () => {});
      await mgr.shutdown();
      expect(mgr.getStatus().phase).toBe("done");
    });

    it("tracks completed hooks", async () => {
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register("hook_a", async () => {});
      mgr.register("hook_b", async () => {});
      await mgr.shutdown();
      const status = mgr.getStatus();
      expect(status.completedHooks).toContain("hook_a");
      expect(status.completedHooks).toContain("hook_b");
      expect(status.failedHooks).toHaveLength(0);
    });

    it("sets phase to error when a hook fails", async () => {
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register("broken", async () => {
        throw new Error("cleanup failed");
      });
      await mgr.shutdown();
      const status = mgr.getStatus();
      expect(status.phase).toBe("error");
      expect(status.failedHooks).toContain("broken");
    });

    it("continues executing remaining hooks after one fails", async () => {
      const executed: string[] = [];
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register(
        "first",
        async () => {
          throw new Error("fail");
        },
        10,
      );
      mgr.register(
        "second",
        async () => {
          executed.push("second");
        },
        20,
      );
      await mgr.shutdown();
      expect(executed).toContain("second");
    });

    it("is idempotent — concurrent calls return same promise", async () => {
      let callCount = 0;
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register("counter", async () => {
        callCount++;
      });
      await Promise.all([mgr.shutdown(), mgr.shutdown(), mgr.shutdown()]);
      expect(callCount).toBe(1);
    });

    it("sets startedAt on shutdown initiation", async () => {
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      expect(mgr.getStatus().startedAt).toBeNull();
      await mgr.shutdown();
      expect(mgr.getStatus().startedAt).toBeInstanceOf(Date);
    });
  });

  describe("timeout handling", () => {
    it("sets phase to error when hook exceeds timeout", async () => {
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        timeoutMs: 50,
        logger: silentLogger as never,
      });
      mgr.register("slow", async () => {
        await new Promise((r) => setTimeout(r, 200));
      });
      await mgr.shutdown();
      const status = mgr.getStatus();
      expect(status.phase).toBe("error");
    });
  });

  describe("getStatus", () => {
    it("returns a snapshot (not live reference)", async () => {
      const mgr = new GracefulShutdownManager({
        exitOnComplete: false,
        logger: silentLogger as never,
      });
      mgr.register("noop", async () => {});
      await mgr.shutdown();
      const status1 = mgr.getStatus();
      const status2 = mgr.getStatus();
      // Should be equal value but different array references
      expect(status1.completedHooks).toEqual(status2.completedHooks);
      expect(status1.completedHooks).not.toBe(status2.completedHooks);
    });
  });
});
