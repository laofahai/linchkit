/**
 * PostgresCacheInvalidator — unit tests
 *
 * Tests focus on the payload parsing and cache invalidation logic
 * without requiring a real Postgres connection.
 */

import { describe, expect, it } from "bun:test";
import { CacheManager } from "../src/cache/cache-manager";
import {
  CACHE_INVALIDATION_CHANNEL,
  PostgresCacheInvalidator,
} from "../src/cache/postgres-invalidator";

// ── Helpers ──────────────────────────────────────────────────

/**
 * Create a PostgresCacheInvalidator and expose its private handleNotification
 * via a type cast for unit testing without a real Postgres connection.
 */
function createTestInvalidator(cacheManager: CacheManager): {
  invalidator: PostgresCacheInvalidator;
  handleNotification: (payload: string) => void;
} {
  const invalidator = new PostgresCacheInvalidator({
    connectionUrl: "postgres://localhost/test",
    cacheManager,
  });

  // Access private method for unit testing
  const handleNotification = (
    invalidator as unknown as { handleNotification: (p: string) => void }
  ).handleNotification.bind(invalidator);

  return { invalidator, handleNotification };
}

// ── Tests ─────────────────────────────────────────────────────

describe("PostgresCacheInvalidator", () => {
  it("exports CACHE_INVALIDATION_CHANNEL constant", () => {
    expect(CACHE_INVALIDATION_CHANNEL).toBe("linchkit_cache_invalidation");
  });

  describe("handleNotification — schema invalidation", () => {
    it("invalidates schema tag when type=schema payload received", () => {
      const manager = new CacheManager();
      manager.set("data", "cached", { tags: ["entity:orders"] });

      const { handleNotification } = createTestInvalidator(manager);

      handleNotification(JSON.stringify({ type: "entity", target: "orders" }));

      expect(manager.get("data")).toBeUndefined();
    });

    it("invalidates tenant-scoped schema tag", () => {
      const manager = new CacheManager();
      manager.set("t1-data", "v1", { tags: ["entity:t1:orders"] });
      manager.set("t2-data", "v2", { tags: ["entity:t2:orders"] });

      const { handleNotification } = createTestInvalidator(manager);

      handleNotification(JSON.stringify({ type: "entity", target: "orders", tenantId: "t1" }));

      expect(manager.get("t1-data")).toBeUndefined();
      expect(manager.get("t2-data")).toBe("v2"); // different tenant unaffected
    });
  });

  describe("handleNotification — permission invalidation", () => {
    it("invalidates permission tag when type=permission payload received", () => {
      const manager = new CacheManager();
      manager.set("perm1", "allow", { tags: ["perm:t1"] });
      manager.set("other", "v", { tags: ["entity:t1:orders"] });

      const { handleNotification } = createTestInvalidator(manager);

      handleNotification(JSON.stringify({ type: "permission", target: "roles", tenantId: "t1" }));

      expect(manager.get("perm1")).toBeUndefined();
      expect(manager.get("other")).toBe("v"); // non-perm unaffected
    });

    it("invalidates global perm tag when no tenantId", () => {
      const manager = new CacheManager();
      manager.set("perm-global", "allow", { tags: ["perm"] });

      const { handleNotification } = createTestInvalidator(manager);

      handleNotification(JSON.stringify({ type: "permission", target: "roles" }));

      expect(manager.get("perm-global")).toBeUndefined();
    });
  });

  describe("handleNotification — definition invalidation", () => {
    it("invalidates definition prefix when type=definition payload received", () => {
      const manager = new CacheManager();
      manager.set("override:t1:entity:orders", "v1");
      manager.set("override:t1:entity:products", "v2");
      manager.set("other-key", "v3");

      const { handleNotification } = createTestInvalidator(manager);

      handleNotification(JSON.stringify({ type: "definition", target: "entity", tenantId: "t1" }));

      expect(manager.get("override:t1:entity:orders")).toBeUndefined();
      expect(manager.get("override:t1:entity:products")).toBeUndefined();
      expect(manager.get("other-key")).toBe("v3");
    });
  });

  describe("handleNotification — error cases", () => {
    it("ignores invalid JSON payload without throwing", () => {
      const manager = new CacheManager();
      const _logs: string[] = [];
      const { handleNotification } = createTestInvalidator(manager);
      // Should not throw
      expect(() => handleNotification("not-json")).not.toThrow();
    });

    it("does not crash on unknown type", () => {
      const manager = new CacheManager();
      const { handleNotification } = createTestInvalidator(manager);
      expect(() =>
        handleNotification(JSON.stringify({ type: "unknown_type", target: "foo" })),
      ).not.toThrow();
    });
  });
});
