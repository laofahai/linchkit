/**
 * SystemDataProvider — ExecutionLogger fallback tests
 *
 * Validates that when no DB is available, execution_log queries
 * fall back to reading from the in-memory ExecutionLogger and
 * properly convert ExecutionLogEntry (camelCase) to system schema
 * records (snake_case) with ISO-serialized timestamps.
 */

import { describe, expect, test } from "bun:test";
import type { ExecutionLogEntry } from "@linchkit/core";
import { InMemoryExecutionLogger, InMemoryStore } from "@linchkit/core/server";
import { SystemDataProvider } from "../src/system-data-provider";

function makeSampleEntry(overrides: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry {
  return {
    id: "exec-001",
    action: "create_task",
    entity: "task",
    recordId: "task-123",
    actor: { type: "human", id: "user-1", groups: [] },
    input: { title: "Test Task" },
    status: "succeeded",
    duration: 42,
    startedAt: new Date("2026-03-27T10:00:00.000Z"),
    completedAt: new Date("2026-03-27T10:00:00.042Z"),
    channel: "graphql",
    ...overrides,
  };
}

describe("SystemDataProvider execution_log fallback (no DB)", () => {
  test("query returns converted records with snake_case fields and ISO timestamps", async () => {
    const logger = new InMemoryExecutionLogger();
    const entry = makeSampleEntry();
    logger.log(entry);

    const provider = new SystemDataProvider(new InMemoryStore(), {
      executionLogger: logger,
    });

    const results = await provider.query("execution_log", {});
    expect(results).toHaveLength(1);

    const record = results[0];
    expect(record.id).toBe("exec-001");
    expect(record.action_name).toBe("create_task");
    expect(record.entity_name).toBe("task");
    expect(record.record_id).toBe("task-123");
    expect(record.actor_id).toBe("user-1");
    expect(record.actor_type).toBe("human");
    expect(record.status).toBe("succeeded");
    expect(record.duration_ms).toBe(42);
    expect(record.channel).toBe("graphql");

    // Timestamps must be ISO strings, not Date objects
    expect(record.started_at).toBe("2026-03-27T10:00:00.000Z");
    expect(record.completed_at).toBe("2026-03-27T10:00:00.042Z");
    expect(typeof record.started_at).toBe("string");
    expect(typeof record.completed_at).toBe("string");

    // Input should be JSON-serialized
    expect(typeof record.input).toBe("string");
    const parsed = JSON.parse(record.input as string);
    expect(parsed.title).toBe("Test Task");
  });

  test("count returns correct total", async () => {
    const logger = new InMemoryExecutionLogger();
    logger.log(makeSampleEntry({ id: "exec-001" }));
    logger.log(makeSampleEntry({ id: "exec-002", action: "update_task" }));
    logger.log(makeSampleEntry({ id: "exec-003", status: "failed" }));

    const provider = new SystemDataProvider(new InMemoryStore(), {
      executionLogger: logger,
    });

    const total = await provider.count("execution_log");
    expect(total).toBe(3);

    // With filter
    const failedCount = await provider.count("execution_log", { status: "failed" });
    expect(failedCount).toBe(1);
  });

  test("get returns single record by id with proper field mapping", async () => {
    const logger = new InMemoryExecutionLogger();
    logger.log(makeSampleEntry({ id: "exec-001" }));
    logger.log(makeSampleEntry({ id: "exec-002" }));

    const provider = new SystemDataProvider(new InMemoryStore(), {
      executionLogger: logger,
    });

    const record = await provider.get("execution_log", "exec-001");
    expect(record.id).toBe("exec-001");
    expect(record.started_at).toBe("2026-03-27T10:00:00.000Z");
    expect(record.completed_at).toBe("2026-03-27T10:00:00.042Z");
  });

  test("get throws for non-existent id", async () => {
    const logger = new InMemoryExecutionLogger();

    const provider = new SystemDataProvider(new InMemoryStore(), {
      executionLogger: logger,
    });

    expect(provider.get("execution_log", "nonexistent")).rejects.toThrow("not found");
  });

  test("query supports pagination", async () => {
    const logger = new InMemoryExecutionLogger();
    for (let i = 0; i < 5; i++) {
      logger.log(makeSampleEntry({ id: `exec-${i}` }));
    }

    const provider = new SystemDataProvider(new InMemoryStore(), {
      executionLogger: logger,
    });

    const page1 = await provider.query("execution_log", { page: 1, pageSize: 2 });
    expect(page1).toHaveLength(2);

    const page3 = await provider.query("execution_log", { page: 3, pageSize: 2 });
    expect(page3).toHaveLength(1);
  });

  test("query with filter by action_name", async () => {
    const logger = new InMemoryExecutionLogger();
    logger.log(makeSampleEntry({ id: "exec-001", action: "create_task" }));
    logger.log(makeSampleEntry({ id: "exec-002", action: "update_task" }));
    logger.log(makeSampleEntry({ id: "exec-003", action: "create_task" }));

    const provider = new SystemDataProvider(new InMemoryStore(), {
      executionLogger: logger,
    });

    const results = await provider.query("execution_log", { action_name: "create_task" });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.action_name).toBe("create_task");
    }
  });

  test("error fields are properly mapped", async () => {
    const logger = new InMemoryExecutionLogger();
    logger.log(
      makeSampleEntry({
        id: "exec-err",
        status: "failed",
        error: { code: "NOT_FOUND", message: "Record not found" },
      }),
    );

    const provider = new SystemDataProvider(new InMemoryStore(), {
      executionLogger: logger,
    });

    const results = await provider.query("execution_log", {});
    const record = results[0];
    expect(record.error_code).toBe("NOT_FOUND");
    expect(record.error_message).toBe("Record not found");
  });

  test("returns empty when no executionLogger is provided", async () => {
    const provider = new SystemDataProvider(new InMemoryStore(), {});

    const results = await provider.query("execution_log", {});
    expect(results).toHaveLength(0);

    const total = await provider.count("execution_log");
    expect(total).toBe(0);
  });
});
