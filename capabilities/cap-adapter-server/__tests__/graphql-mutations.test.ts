import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import { createActionExecutor } from "@linchkit/core";
import { InMemoryStore } from "../src/data/in-memory-store";
import { buildGraphQLSchema, generateCrudActions } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Setup ────────────────────────────────────────────────

const taskSchema: SchemaDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    story_points: { type: "number", label: "Story Points" },
    is_done: { type: "boolean", label: "Done" },
    status: { type: "state", machine: "task_lifecycle" },
  },
};

const store = new InMemoryStore();
const executor = createActionExecutor({ dataProvider: store });

// Register CRUD actions
for (const action of generateCrudActions(taskSchema)) {
  executor.registry.register(action);
}

const graphqlSchema = buildGraphQLSchema([taskSchema], { executor, dataProvider: store });
const app = createServer(graphqlSchema);
const port = 3998;

beforeAll(() => {
  app.listen(port);
});

afterAll(() => {
  app.stop();
});

// ── Helper ────────────────────────────────────────────────

async function gql(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${port}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{ data: Record<string, unknown>; errors?: unknown[] }>;
}

// ── Tests ─────────────────────────────────────────────────

describe("GraphQL mutations (wired)", () => {
  test("createTask creates a record in the store", async () => {
    const result = await gql(`
			mutation {
				createTask(input: { title: "Write tests", story_points: 5 }) {
					id
					title
					story_points
					created_at
					_version
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const task = result.data.createTask as Record<string, unknown>;
    expect(task.title).toBe("Write tests");
    expect(task.story_points).toBe(5);
    expect(task._version).toBe(1);
    expect(task.id).toBeDefined();

    // Verify it's in the store
    const stored = await store.get("task", task.id as string);
    expect(stored.title).toBe("Write tests");
  });

  test("updateTask updates a record", async () => {
    // Create first
    const _created = await store.create("task", {
      id: "update_test",
      title: "Original",
      story_points: 1,
    });

    const result = await gql(`
			mutation {
				updateTask(id: "update_test", input: { title: "Updated", story_points: 8 }) {
					id
					title
					story_points
					_version
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const task = result.data.updateTask as Record<string, unknown>;
    expect(task.title).toBe("Updated");
    expect(task.story_points).toBe(8);
    expect(task._version).toBe(2);
  });

  test("deleteTask removes a record", async () => {
    await store.create("task", { id: "delete_test", title: "To Delete" });

    const result = await gql(`
			mutation {
				deleteTask(id: "delete_test")
			}
		`);

    expect(result.errors).toBeUndefined();
    expect(result.data.deleteTask).toBe(true);

    // Verify it's gone
    await expect(store.get("task", "delete_test")).rejects.toThrow();
  });
});

describe("GraphQL queries (wired)", () => {
  test("task query returns a record from store", async () => {
    await store.create("task", {
      id: "query_test",
      title: "Query Me",
      story_points: 3,
    });

    const result = await gql(`
			query {
				task(id: "query_test") {
					id
					title
					story_points
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const task = result.data.task as Record<string, unknown>;
    expect(task.id).toBe("query_test");
    expect(task.title).toBe("Query Me");
  });

  test("taskList returns { items, total } structure", async () => {
    // Clear and seed
    store.clear();
    await store.create("task", { id: "list_1", title: "Task A" });
    await store.create("task", { id: "list_2", title: "Task B" });

    const result = await gql(`
			query {
				taskList {
					items {
						id
						title
					}
					total
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const listResult = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(listResult.items.length).toBe(2);
    expect(listResult.total).toBe(2);
  });

  test("taskList supports page/pageSize pagination", async () => {
    store.clear();
    await store.create("task", { id: "p1", title: "Task 1" });
    await store.create("task", { id: "p2", title: "Task 2" });
    await store.create("task", { id: "p3", title: "Task 3" });

    const result = await gql(`
			query {
				taskList(page: 2, pageSize: 1) {
					items {
						id
					}
					total
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const listResult = result.data.taskList as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(listResult.items.length).toBe(1);
    expect(listResult.total).toBe(3);
  });

  test("task query returns null for non-existent record", async () => {
    const result = await gql(`
			query {
				task(id: "nonexistent") {
					id
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    expect(result.data.task).toBeNull();
  });
});

describe("executeAction mutation", () => {
  test("executes a registered action", async () => {
    const result = await gql(`
			mutation {
				executeAction(
					name: "create_task"
					input: "{\\"title\\": \\"Via executeAction\\", \\"story_points\\": 10}"
				) {
					success
					data
					executionId
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const actionResult = result.data.executeAction as Record<string, unknown>;
    expect(actionResult.success).toBe(true);
    expect(actionResult.executionId).toBeDefined();

    const data = JSON.parse(actionResult.data as string);
    expect(data.title).toBe("Via executeAction");
  });

  test("returns error for unknown action", async () => {
    const result = await gql(`
			mutation {
				executeAction(
					name: "nonexistent_action"
					input: "{}"
				) {
					success
					errors {
						code
						message
					}
				}
			}
		`);

    expect(result.errors).toBeUndefined();
    const actionResult = result.data.executeAction as Record<string, unknown>;
    expect(actionResult.success).toBe(false);
    const errors = actionResult.errors as Array<Record<string, string>>;
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("ACTION_FAILED");
  });
});
