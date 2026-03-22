import { describe, expect, test } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import { generateGraphQLInputType, generateGraphQLObjectType } from "../src/graphql";

// ── Test fixtures ────────────────────────────────────────

const taskSchema: SchemaDefinition = {
  name: "task",
  label: "Task",
  description: "A project task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    priority: {
      type: "enum",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      required: true,
    },
    is_archived: { type: "boolean" },
    due_date: { type: "date" },
    scheduled_at: { type: "datetime" },
    story_points: { type: "number" },
    metadata: { type: "json" },
    assignee_id: { type: "ref", target: "user" },
    status: { type: "state", machine: "task_lifecycle" },
    full_name: { type: "computed", compute: (r) => `${r.title}` },
    subtasks: { type: "has_many", target: "subtask" },
    tags: { type: "many_to_many", target: "tag" },
  },
};

// ── Object type tests ────────────────────────────────────

describe("generateGraphQLObjectType", () => {
  const objectType = generateGraphQLObjectType(taskSchema);
  const fields = objectType.getFields();

  test("returns a GraphQLObjectType with PascalCase name", () => {
    expect(objectType).toBeInstanceOf(GraphQLObjectType);
    expect(objectType.name).toBe("Task");
    expect(objectType.description).toBe("A project task");
  });

  test("includes system fields with correct types", () => {
    // id: ID!
    expect(fields.id).toBeDefined();
    expect(fields.id.type).toBeInstanceOf(GraphQLNonNull);
    expect((fields.id.type as GraphQLNonNull<typeof GraphQLID>).ofType).toBe(GraphQLID);

    // tenant_id: String
    expect(fields.tenant_id).toBeDefined();
    expect(fields.tenant_id.type).toBe(GraphQLString);

    // created_at: String!
    expect(fields.created_at).toBeDefined();
    expect(fields.created_at.type).toBeInstanceOf(GraphQLNonNull);
    expect((fields.created_at.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(
      GraphQLString,
    );

    // updated_at: String!
    expect(fields.updated_at).toBeDefined();
    expect(fields.updated_at.type).toBeInstanceOf(GraphQLNonNull);

    // created_by: String
    expect(fields.created_by).toBeDefined();
    expect(fields.created_by.type).toBe(GraphQLString);

    // updated_by: String
    expect(fields.updated_by).toBeDefined();
    expect(fields.updated_by.type).toBe(GraphQLString);

    // _version: Int!
    expect(fields._version).toBeDefined();
    expect(fields._version.type).toBeInstanceOf(GraphQLNonNull);
    expect((fields._version.type as GraphQLNonNull<typeof GraphQLInt>).ofType).toBe(GraphQLInt);
  });

  test("maps field types correctly", () => {
    // Output types are always nullable to prevent resolver crashes on missing fields.
    // Required/NonNull enforcement is only on input types.

    // string → String (nullable in output even if required)
    expect(fields.title.type).toBe(GraphQLString);

    // text → String (optional)
    expect(fields.description.type).toBe(GraphQLString);

    // number → Float
    expect(fields.story_points.type).toBe(GraphQLFloat);

    // boolean → Boolean
    expect(fields.is_archived.type).toBe(GraphQLBoolean);

    // date → String
    expect(fields.due_date.type).toBe(GraphQLString);

    // datetime → String
    expect(fields.scheduled_at.type).toBe(GraphQLString);

    // enum → String (nullable in output even if required)
    expect(fields.priority.type).toBe(GraphQLString);

    // json → String
    expect(fields.metadata.type).toBe(GraphQLString);

    // ref → String
    expect(fields.assignee_id.type).toBe(GraphQLString);

    // state → String
    expect(fields.status.type).toBe(GraphQLString);
  });

  test("skips computed, has_many, and many_to_many fields", () => {
    expect(fields.full_name).toBeUndefined();
    expect(fields.subtasks).toBeUndefined();
    expect(fields.tags).toBeUndefined();
  });

  test("output fields are always nullable to prevent resolver crashes", () => {
    // In output types, all user-defined fields are nullable.
    // Safe resolvers return null for missing fields instead of crashing.
    // Required/NonNull is only enforced on input types.
    expect(fields.title.type).toBe(GraphQLString);
    expect(fields.title.type).not.toBeInstanceOf(GraphQLNonNull);
    // description is also nullable
    expect(fields.description.type).not.toBeInstanceOf(GraphQLNonNull);
  });
});

// ── Input type tests ─────────────────────────────────────

describe("generateGraphQLInputType", () => {
  const inputType = generateGraphQLInputType(taskSchema);
  const fields = inputType.getFields();

  test("returns a GraphQLInputObjectType with correct name", () => {
    expect(inputType).toBeInstanceOf(GraphQLInputObjectType);
    expect(inputType.name).toBe("TaskInput");
  });

  test("excludes system fields", () => {
    expect(fields.id).toBeUndefined();
    expect(fields.tenant_id).toBeUndefined();
    expect(fields.created_at).toBeUndefined();
    expect(fields.updated_at).toBeUndefined();
    expect(fields.created_by).toBeUndefined();
    expect(fields.updated_by).toBeUndefined();
    expect(fields._version).toBeUndefined();
  });

  test("includes user-defined fields with correct types", () => {
    expect(fields.title).toBeDefined();
    expect(fields.title.type).toBeInstanceOf(GraphQLNonNull);

    expect(fields.story_points).toBeDefined();
    expect(fields.story_points.type).toBe(GraphQLFloat);
  });

  test("skips computed, has_many, and many_to_many fields", () => {
    expect(fields.full_name).toBeUndefined();
    expect(fields.subtasks).toBeUndefined();
    expect(fields.tags).toBeUndefined();
  });
});

// ── All field types coverage ─────────────────────────────

describe("all field types", () => {
  const allTypesSchema: SchemaDefinition = {
    name: "all_types",
    fields: {
      f_string: { type: "string", required: true },
      f_text: { type: "text" },
      f_number: { type: "number", required: true },
      f_boolean: { type: "boolean" },
      f_date: { type: "date" },
      f_datetime: { type: "datetime" },
      f_enum: { type: "enum", options: [{ value: "a" }, { value: "b" }] },
      f_json: { type: "json" },
      f_ref: { type: "ref", target: "other" },
      f_state: { type: "state", machine: "lifecycle" },
      f_computed: { type: "computed", compute: () => null },
      f_has_many: { type: "has_many", target: "child" },
      f_m2m: { type: "many_to_many", target: "related" },
    },
  };

  const objectType = generateGraphQLObjectType(allTypesSchema);
  const fields = objectType.getFields();

  test("generates PascalCase name from snake_case", () => {
    expect(objectType.name).toBe("AllTypes");
  });

  test("all storable field types produce GraphQL fields", () => {
    const expectedFields = [
      "f_string",
      "f_text",
      "f_number",
      "f_boolean",
      "f_date",
      "f_datetime",
      "f_enum",
      "f_json",
      "f_ref",
      "f_state",
    ];
    for (const name of expectedFields) {
      expect(fields[name]).toBeDefined();
    }
  });

  test("virtual field types are excluded", () => {
    expect(fields.f_computed).toBeUndefined();
    expect(fields.f_has_many).toBeUndefined();
    expect(fields.f_m2m).toBeUndefined();
  });
});
