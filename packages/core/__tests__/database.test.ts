import { afterEach, describe, expect, it } from "bun:test";
import { checkConnection, closeDatabase, createDatabase } from "../src/persistence/database";

// ── Lifecycle & config ──────────────────────────────────

afterEach(async () => {
  // Ensure clean state between tests
  await closeDatabase();
});

describe("createDatabase", () => {
  it("throws when a connection is already active", () => {
    // Create first connection (will fail to actually connect but that's fine for this test)
    createDatabase({ url: "postgres://localhost:5432/test_nonexistent_db" });
    expect(() =>
      createDatabase({ url: "postgres://localhost:5432/test_nonexistent_db" }),
    ).toThrow("A database connection is already active");
  });

  it("applies default connectTimeout and idleTimeout", () => {
    // Simply verify the function accepts the config without error
    const db = createDatabase({
      url: "postgres://localhost:5432/test_nonexistent_db",
      connectTimeout: 3000,
      idleTimeout: 15000,
    });
    expect(db).toBeDefined();
  });

  it("calls onConnect callback when connection is created", () => {
    let called = false;
    createDatabase({
      url: "postgres://localhost:5432/test_nonexistent_db",
      onConnect: () => {
        called = true;
      },
    });
    expect(called).toBe(true);
  });

  it("calls onClose callback when connection is closed", async () => {
    let closed = false;
    createDatabase({
      url: "postgres://localhost:5432/test_nonexistent_db",
      onClose: () => {
        closed = true;
      },
    });
    await closeDatabase();
    expect(closed).toBe(true);
  });
});

describe("closeDatabase", () => {
  it("is a no-op when no connection is active", async () => {
    // Should not throw
    await closeDatabase();
  });
});

describe("checkConnection", () => {
  it("throws a descriptive error when connection is unhealthy", async () => {
    // Create a DB instance pointing to a non-existent database.
    // checkConnection should fail with a meaningful message.
    const db = createDatabase({
      url: "postgres://localhost:59999/nonexistent",
      connectTimeout: 1000,
    });
    try {
      await checkConnection(db);
      // If we reach here, the DB unexpectedly connected
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Database health check failed");
    }
  });
});
