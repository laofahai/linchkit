import { beforeEach, describe, expect, test } from "bun:test";
import { InMemoryStore } from "../src/data/in-memory-store";

describe("InMemoryStore", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  test("create generates id, timestamps, and _version", async () => {
    const record = await store.create("task", { title: "Test" });

    expect(record.id).toBeDefined();
    expect(typeof record.id).toBe("string");
    expect(record.created_at).toBeDefined();
    expect(record.updated_at).toBeDefined();
    expect(record._version).toBe(1);
    expect(record.title).toBe("Test");
  });

  test("create preserves provided id", async () => {
    const record = await store.create("task", {
      id: "custom_id",
      title: "Test",
    });
    expect(record.id).toBe("custom_id");
  });

  test("get returns a record by id", async () => {
    await store.create("task", { id: "t1", title: "Task 1" });
    const record = await store.get("task", "t1");
    expect(record.title).toBe("Task 1");
  });

  test("get throws for non-existent record", async () => {
    await expect(store.get("task", "nope")).rejects.toThrow("Record not found");
  });

  test("update merges fields and increments _version", async () => {
    await store.create("task", { id: "t1", title: "Old" });
    const updated = await store.update("task", "t1", { title: "New" });

    expect(updated.title).toBe("New");
    expect(updated._version).toBe(2);
    expect(updated.id).toBe("t1");
  });

  test("update throws for non-existent record", async () => {
    await expect(store.update("task", "nope", { title: "X" })).rejects.toThrow("Record not found");
  });

  test("delete removes a record", async () => {
    await store.create("task", { id: "t1", title: "Task" });
    await store.delete("task", "t1");
    await expect(store.get("task", "t1")).rejects.toThrow("Record not found");
  });

  test("delete throws for non-existent record", async () => {
    await expect(store.delete("task", "nope")).rejects.toThrow("Record not found");
  });

  test("query filters records", async () => {
    await store.create("task", { id: "t1", status: "done" });
    await store.create("task", { id: "t2", status: "pending" });
    await store.create("task", { id: "t3", status: "done" });

    const results = await store.query("task", { status: "done" });
    expect(results.length).toBe(2);
    expect(results.every((r) => r.status === "done")).toBe(true);
  });

  test("findMany supports sorting", () => {
    store.seed("task", [
      { id: "a", amount: 30 },
      { id: "b", amount: 10 },
      { id: "c", amount: 20 },
    ]);

    const asc = store.findMany("task", {
      sort: { field: "amount", order: "asc" },
    });
    expect(asc[0].amount).toBe(10);
    expect(asc[2].amount).toBe(30);

    const desc = store.findMany("task", {
      sort: { field: "amount", order: "desc" },
    });
    expect(desc[0].amount).toBe(30);
    expect(desc[2].amount).toBe(10);
  });

  test("findMany supports pagination", () => {
    store.seed("item", [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }]);

    const page = store.findMany("item", { offset: 1, limit: 2 });
    expect(page.length).toBe(2);
  });

  test("seed populates records with system fields", () => {
    store.seed("task", [{ id: "s1", title: "Seeded" }]);
    const records = store.findMany("task");
    expect(records.length).toBe(1);
    expect(records[0].title).toBe("Seeded");
    expect(records[0].created_at).toBeDefined();
    expect(records[0]._version).toBe(1);
  });

  test("count returns correct number", () => {
    store.seed("task", [{ id: "1" }, { id: "2" }, { id: "3" }]);
    expect(store.count("task")).toBe(3);
    expect(store.count("task", { id: "2" })).toBe(1);
  });

  test("clear removes all data", () => {
    store.seed("task", [{ id: "1" }]);
    store.seed("user", [{ id: "u1" }]);
    store.clear();
    expect(store.count("task")).toBe(0);
    expect(store.count("user")).toBe(0);
  });
});
