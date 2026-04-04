/**
 * Permission middleware cache integration tests (spec §4)
 *
 * Tests that permission checks are cached per actor+tenant+action+schema,
 * and that the cache is invalidated by permission-related write events.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Actor, CommandContext } from "@linchkit/core";
import { CacheManager, PermissionRegistry } from "@linchkit/core/server";
import { createPermissionMiddleware } from "../src/middleware/permission-middleware";

// ── Fixtures ─────────────────────────────────────────────────

// Capability name = action.schema (the default resolver in permission middleware)
// PermissionValue is true | false | undefined — not an object
const group1 = {
  name: "editors",
  permissions: {
    task: {
      task: {
        actions: {
          create_task: true,
          update_task: true,
          list_task: true,
        },
      },
    },
  },
};

function makeActor(id: string, groups: string[] = ["editors"]): Actor {
  return { type: "user", id, groups };
}

function makeCtx(
  actor: Actor,
  command: string,
  schema?: string,
  tenantId?: string,
): CommandContext {
  return {
    actor,
    command,
    action: schema ? { name: command, entity: schema } : undefined,
    meta: tenantId ? { tenantId } : {},
    payload: {},
    result: undefined,
  } as unknown as CommandContext;
}

// ── Tests ─────────────────────────────────────────────────────

describe("Permission middleware cache", () => {
  let registry: PermissionRegistry;
  let cacheManager: CacheManager;
  beforeEach(() => {
    registry = new PermissionRegistry();
    registry.register(group1);
    cacheManager = new CacheManager();
  });

  it("caches permission result on second call for same actor+command", async () => {
    const middleware = createPermissionMiddleware({ registry, cacheManager });
    const actor = makeActor("user1");
    const ctx = makeCtx(actor, "create_task", "task");

    let callCount = 0;
    const next = async () => {
      callCount++;
    };

    await middleware(ctx, next);
    await middleware(ctx, next);

    // next() called twice but permission check should hit cache on second call
    expect(callCount).toBe(2);
    // Cache should have 1 entry
    const stats = cacheManager.stats();
    expect(stats.l1.hits).toBeGreaterThanOrEqual(1);
    expect(stats.l1.misses).toBe(1); // only 1 miss on first call
  });

  it("does not cache when no cacheManager provided", async () => {
    const middleware = createPermissionMiddleware({ registry }); // no cacheManager
    const actor = makeActor("user1");
    const ctx = makeCtx(actor, "create_task", "task");
    const next = async () => {};

    // Should not throw and should not use cache
    await expect(middleware(ctx, next)).resolves.toBeUndefined();
    // Call again — no caching means registry is consulted each time
    await expect(middleware(ctx, next)).resolves.toBeUndefined();
  });

  it("throws AuthorizationError for denied action (uncached and cached)", async () => {
    const middleware = createPermissionMiddleware({ registry, cacheManager });
    const actor = makeActor("user1", ["editors"]);
    // "delete_task" is not in the permissions
    const ctx = makeCtx(actor, "delete_task", "task");
    const next = async () => {};

    // First call: should throw and cache the denial
    await expect(middleware(ctx, next)).rejects.toThrow("Permission denied");

    // Second call: should throw from cache
    await expect(middleware(ctx, next)).rejects.toThrow("Permission denied");
    const stats = cacheManager.stats();
    expect(stats.l1.hits).toBeGreaterThanOrEqual(1); // cached denial hit
  });

  it("skips cache check for system actors", async () => {
    const middleware = createPermissionMiddleware({ registry, cacheManager });
    const systemActor: Actor = { type: "system", id: "internal-service", groups: [] };
    const ctx = makeCtx(systemActor, "any_action");
    const next = async () => {};

    await middleware(ctx, next);
    // System actors bypass permission check entirely — no cache entry created
    expect(cacheManager.stats().l1.size).toBe(0);
  });

  it("skips cache check for public actions", async () => {
    const middleware = createPermissionMiddleware({
      registry,
      cacheManager,
      publicActions: ["login"],
    });
    const actor = makeActor("user1");
    const ctx = makeCtx(actor, "login");
    const next = async () => {};

    await middleware(ctx, next);
    expect(cacheManager.stats().l1.size).toBe(0);
  });

  it("uses separate cache keys for different tenants", async () => {
    const middleware = createPermissionMiddleware({ registry, cacheManager });
    const actor = makeActor("user1");

    const ctxT1 = makeCtx(actor, "create_task", "task", "tenant1");
    const ctxT2 = makeCtx(actor, "create_task", "task", "tenant2");
    const next = async () => {};

    await middleware(ctxT1, next);
    await middleware(ctxT2, next);

    // Two separate cache entries for different tenants
    expect(cacheManager.stats().l1.size).toBe(2);
    expect(cacheManager.stats().l1.misses).toBe(2);
  });

  it("cache is invalidated by tag perm:{tenantId} via CacheManager", async () => {
    const middleware = createPermissionMiddleware({ registry, cacheManager });
    const actor = makeActor("user1");
    const ctx = makeCtx(actor, "create_task", "task", "t1");
    const next = async () => {};

    await middleware(ctx, next);
    expect(cacheManager.stats().l1.size).toBe(1);

    // Simulate permission-related write event
    cacheManager.invalidateByTag("perm:t1");
    expect(cacheManager.stats().l1.size).toBe(0);

    // Next call misses cache
    await middleware(ctx, next);
    expect(cacheManager.stats().l1.misses).toBe(2);
  });
});
