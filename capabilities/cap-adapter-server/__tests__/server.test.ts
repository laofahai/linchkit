import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import { printSchema } from "graphql";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import { createServer } from "../src/server";

// ── Test fixtures ────────────────────────────────────────

const taskSchema: SchemaDefinition = {
  name: "task",
  label: "Task",
  description: "A project task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    story_points: { type: "number", label: "Story Points" },
    is_done: { type: "boolean", label: "Done" },
    status: { type: "state", machine: "task_lifecycle" },
  },
};

const userSchema: SchemaDefinition = {
  name: "user",
  label: "User",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    email: { type: "string", required: true, label: "Email" },
  },
};

// ── buildGraphQLSchema tests ─────────────────────────────

describe("buildGraphQLSchema", () => {
  test("creates a valid schema with query and mutation types", () => {
    const schema = buildGraphQLSchema([taskSchema]);

    const queryType = schema.getQueryType();
    expect(queryType).toBeDefined();
    expect(queryType?.name).toBe("Query");

    const mutationType = schema.getMutationType();
    expect(mutationType).toBeDefined();
    expect(mutationType?.name).toBe("Mutation");
  });

  test("generates get-by-id and list queries for each schema", () => {
    const schema = buildGraphQLSchema([taskSchema, userSchema]);
    const queryType = schema.getQueryType();
    if (!queryType) throw new Error("expected query type");
    const queryFields = queryType.getFields();

    // task queries
    expect(queryFields.task).toBeDefined();
    expect(queryFields.taskList).toBeDefined();

    // user queries
    expect(queryFields.user).toBeDefined();
    expect(queryFields.userList).toBeDefined();
  });

  test("generates create and update mutations for each schema", () => {
    const schema = buildGraphQLSchema([taskSchema, userSchema]);
    const mutationType = schema.getMutationType();
    if (!mutationType) throw new Error("expected mutation type");
    const mutationFields = mutationType.getFields();

    expect(mutationFields.createTask).toBeDefined();
    expect(mutationFields.updateTask).toBeDefined();
    expect(mutationFields.createUser).toBeDefined();
    expect(mutationFields.updateUser).toBeDefined();
  });

  test("produces a printable SDL", () => {
    const schema = buildGraphQLSchema([taskSchema]);
    const sdl = printSchema(schema);

    expect(sdl).toContain("type Task");
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("type Mutation");
    expect(sdl).toContain("task(id: ID!): Task");
    expect(sdl).toContain("): TaskListResult!");
    expect(sdl).toContain("createTask(input: TaskInput!): Task");
    expect(sdl).toContain("updateTask(id: ID!, input: TaskInput!): Task");
  });

  test("handles empty schemas array with a placeholder query", () => {
    const schema = buildGraphQLSchema([]);
    const emptyQueryType = schema.getQueryType();
    if (!emptyQueryType) throw new Error("expected query type");
    const queryFields = emptyQueryType.getFields();
    expect(queryFields._empty).toBeDefined();
  });
});

// ── Server integration tests ─────────────────────────────

describe("createServer", () => {
  const schema = buildGraphQLSchema([taskSchema]);
  const app = createServer(schema);
  const port = 3999; // Use a different port for tests

  beforeAll(() => {
    app.listen(port);
  });

  afterAll(() => {
    app.stop();
  });

  test("health check returns ok", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    expect(body.version).toBe("0.0.1");
  });

  test("GraphQL endpoint responds to introspection query", async () => {
    const introspectionQuery = `{
			__schema {
				queryType { name }
				mutationType { name }
			}
		}`;

    const res = await fetch(`http://localhost:${port}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: introspectionQuery }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        __schema: {
          queryType: { name: string };
          mutationType: { name: string };
        };
      };
    };
    expect(body.data.__schema.queryType.name).toBe("Query");
    expect(body.data.__schema.mutationType.name).toBe("Mutation");
  });

  test("GraphQL query resolves a stub task", async () => {
    const query = `{
			task(id: "test_123") {
				id
				title
				_version
			}
		}`;

    const res = await fetch(`http://localhost:${port}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { task: { id: string; _version: number } };
    };
    expect(body.data.task.id).toBe("test_123");
    expect(body.data.task._version).toBe(1);
  });

  test("action endpoint returns 500 when no executor configured", async () => {
    const res = await fetch(`http://localhost:${port}/api/actions/submit_request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pr_001" }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string; type: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("SYSTEM.SERVER.NOT_CONFIGURED");
    expect(body.error.type).toBe("system");
  });
});
