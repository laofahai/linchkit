import { afterEach, describe, expect, test } from "bun:test";
import type { SchemaDefinition, StateDefinition } from "@linchkit/core";
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import {
  clearEnumTypeCache,
  generateGraphQLInputType,
  generateGraphQLObjectType,
} from "../src/graphql";
import { buildGraphQLSchema } from "../src/graphql/build-schema";

// Clear cache between tests to avoid cross-test contamination
afterEach(() => {
  clearEnumTypeCache();
});

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
    status: { type: "state", machine: "task_lifecycle" },
    full_name: { type: "computed", compute: (r) => `${r.title}` },
  },
};

const taskLifecycleState: StateDefinition = {
  name: "task_lifecycle",
  schema: "task",
  field: "status",
  initial: "draft",
  states: ["draft", "in_progress", "done", "cancelled"],
  transitions: [
    { from: "draft", to: "in_progress", action: "start_task" },
    { from: "in_progress", to: "done", action: "complete_task" },
    { from: ["draft", "in_progress"], to: "cancelled", action: "cancel_task" },
  ],
  meta: {
    draft: { label: "Draft", color: "gray" },
    in_progress: { label: "In Progress", color: "blue" },
    done: { label: "Done", color: "green" },
    cancelled: { label: "Cancelled", color: "red" },
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

    // enum → GraphQLEnumType
    expect(fields.priority.type).toBeInstanceOf(GraphQLEnumType);
    const priorityEnum = fields.priority.type as GraphQLEnumType;
    expect(priorityEnum.name).toBe("TaskPriorityEnum");
    const enumValues = priorityEnum.getValues();
    expect(enumValues).toHaveLength(3);
    expect(enumValues.map((v) => v.value)).toEqual(["low", "medium", "high"]);

    // json → String
    expect(fields.metadata.type).toBe(GraphQLString);

    // state without machine map → String fallback
    expect(fields.status.type).toBe(GraphQLString);
  });

  test("skips computed fields", () => {
    expect(fields.full_name).toBeUndefined();
  });

  test("output fields are always nullable to prevent resolver crashes", () => {
    expect(fields.title.type).toBe(GraphQLString);
    expect(fields.title.type).not.toBeInstanceOf(GraphQLNonNull);
    expect(fields.description.type).not.toBeInstanceOf(GraphQLNonNull);
  });
});

// ── Enum type generation ─────────────────────────────────

describe("enum field generates GraphQLEnumType", () => {
  test("enum field with options produces GraphQLEnumType", () => {
    const objectType = generateGraphQLObjectType(taskSchema);
    const fields = objectType.getFields();
    const priorityType = fields.priority.type;

    expect(priorityType).toBeInstanceOf(GraphQLEnumType);
    const enumType = priorityType as GraphQLEnumType;
    expect(enumType.name).toBe("TaskPriorityEnum");
    const values = enumType.getValues();
    expect(values.map((v) => v.name)).toEqual(["low", "medium", "high"]);
    expect(values.map((v) => v.value)).toEqual(["low", "medium", "high"]);
  });

  test("enum field with labels preserves descriptions", () => {
    const schema: SchemaDefinition = {
      name: "ticket",
      fields: {
        severity: {
          type: "enum",
          options: [
            { value: "low", label: "Low Priority" },
            { value: "high", label: "High Priority" },
          ],
        },
      },
    };
    const objectType = generateGraphQLObjectType(schema);
    const fields = objectType.getFields();
    const enumType = fields.severity.type as GraphQLEnumType;
    expect(enumType.name).toBe("TicketSeverityEnum");
    const values = enumType.getValues();
    expect(values[0].description).toBe("Low Priority");
    expect(values[1].description).toBe("High Priority");
  });

  test("enum values with special characters are sanitized", () => {
    const schema: SchemaDefinition = {
      name: "item",
      fields: {
        category: {
          type: "enum",
          options: [{ value: "in-stock" }, { value: "out-of-stock" }, { value: "3rd-party" }],
        },
      },
    };
    const objectType = generateGraphQLObjectType(schema);
    const fields = objectType.getFields();
    const enumType = fields.category.type as GraphQLEnumType;
    const names = enumType.getValues().map((v) => v.name);
    // Hyphens replaced with underscores, leading digit prefixed
    expect(names).toEqual(["in_stock", "out_of_stock", "_3rd_party"]);
    // Original values preserved
    const values = enumType.getValues().map((v) => v.value);
    expect(values).toEqual(["in-stock", "out-of-stock", "3rd-party"]);
  });

  test("enum field with empty options falls back to String", () => {
    const schema: SchemaDefinition = {
      name: "empty_enum",
      fields: {
        status: {
          type: "enum",
          options: [],
        },
      },
    };
    const objectType = generateGraphQLObjectType(schema);
    const fields = objectType.getFields();
    expect(fields.status.type).toBe(GraphQLString);
  });
});

// ── State field enum generation ──────────────────────────

describe("state field generates GraphQLEnumType with state machine", () => {
  test("state field with machine map produces GraphQLEnumType", () => {
    const machineMap = new Map<string, StateDefinition>();
    machineMap.set("task_lifecycle", taskLifecycleState);

    const objectType = generateGraphQLObjectType(taskSchema, machineMap);
    const fields = objectType.getFields();
    const statusType = fields.status.type;

    expect(statusType).toBeInstanceOf(GraphQLEnumType);
    const enumType = statusType as GraphQLEnumType;
    expect(enumType.name).toBe("TaskStatusState");
    const values = enumType.getValues();
    expect(values.map((v) => v.value)).toEqual(["draft", "in_progress", "done", "cancelled"]);
  });

  test("state field with meta preserves label as description", () => {
    const machineMap = new Map<string, StateDefinition>();
    machineMap.set("task_lifecycle", taskLifecycleState);

    const objectType = generateGraphQLObjectType(taskSchema, machineMap);
    const fields = objectType.getFields();
    const enumType = fields.status.type as GraphQLEnumType;
    const draftValue = enumType.getValues().find((v) => v.value === "draft");
    expect(draftValue?.description).toBe("Draft");
  });

  test("state field without matching machine falls back to String", () => {
    const machineMap = new Map<string, StateDefinition>();
    // No entry for "task_lifecycle"

    const objectType = generateGraphQLObjectType(taskSchema, machineMap);
    const fields = objectType.getFields();
    expect(fields.status.type).toBe(GraphQLString);
  });

  test("state field without machine map falls back to String", () => {
    const objectType = generateGraphQLObjectType(taskSchema);
    const fields = objectType.getFields();
    expect(fields.status.type).toBe(GraphQLString);
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

  test("enum input field uses GraphQLEnumType", () => {
    // priority is required, so it's wrapped in NonNull
    expect(fields.priority.type).toBeInstanceOf(GraphQLNonNull);
    const innerType = (fields.priority.type as GraphQLNonNull<GraphQLEnumType>).ofType;
    expect(innerType).toBeInstanceOf(GraphQLEnumType);
    expect((innerType as GraphQLEnumType).name).toBe("TaskPriorityEnum");
  });

  test("state input field uses GraphQLEnumType when machine map provided", () => {
    const machineMap = new Map<string, StateDefinition>();
    machineMap.set("task_lifecycle", taskLifecycleState);

    const inputWithMachines = generateGraphQLInputType(taskSchema, machineMap);
    const inputFields = inputWithMachines.getFields();
    expect(inputFields.status.type).toBeInstanceOf(GraphQLEnumType);
    expect((inputFields.status.type as GraphQLEnumType).name).toBe("TaskStatusState");
  });

  test("skips computed fields", () => {
    expect(fields.full_name).toBeUndefined();
  });
});

// ── Enum type caching ────────────────────────────────────

describe("enum type caching", () => {
  test("output and input types share the same GraphQLEnumType instance", () => {
    const objectType = generateGraphQLObjectType(taskSchema);
    const inputType = generateGraphQLInputType(taskSchema);

    const outputFields = objectType.getFields();
    const inputFields = inputType.getFields();

    const outputEnum = outputFields.priority.type;
    // Input priority is NonNull-wrapped because required=true
    const inputEnum = (inputFields.priority.type as GraphQLNonNull<GraphQLEnumType>).ofType;

    expect(outputEnum).toBe(inputEnum);
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
      f_state: { type: "state", machine: "lifecycle" },
      f_computed: { type: "computed", compute: () => null },
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
      "f_state",
    ];
    for (const name of expectedFields) {
      expect(fields[name]).toBeDefined();
    }
  });

  test("enum field produces GraphQLEnumType", () => {
    expect(fields.f_enum.type).toBeInstanceOf(GraphQLEnumType);
  });

  test("virtual field types are excluded", () => {
    expect(fields.f_computed).toBeUndefined();
  });
});

// ── Update mutation _version arg ─────────────────────────

describe("buildGraphQLSchema update mutation _version arg", () => {
  const simpleSchema: SchemaDefinition = {
    name: "item",
    label: "Item",
    fields: {
      name: { type: "string", required: true },
    },
  };

  test("update mutation has optional _version: Int argument", () => {
    const schema = buildGraphQLSchema([simpleSchema]);
    const mutationType = schema.getMutationType();
    expect(mutationType).toBeDefined();

    const updateField = mutationType?.getFields().updateItem;
    expect(updateField).toBeDefined();

    const versionArg = updateField.args.find((a) => a.name === "_version");
    expect(versionArg).toBeDefined();
    // Should be nullable Int (not NonNull)
    expect(versionArg?.type).toBe(GraphQLInt);
  });

  test("create mutation does not have _version argument", () => {
    const schema = buildGraphQLSchema([simpleSchema]);
    const mutationType = schema.getMutationType();
    expect(mutationType).toBeDefined();

    const createField = mutationType?.getFields().createItem;
    expect(createField).toBeDefined();

    const versionArg = createField.args.find((a) => a.name === "_version");
    expect(versionArg).toBeUndefined();
  });

  test("_version is not in the input type (system field excluded)", () => {
    const inputType = generateGraphQLInputType(simpleSchema);
    const fields = inputType.getFields();
    expect(fields._version).toBeUndefined();
  });
});

// ── i18n field name collision ─────────────────────────────

describe("i18n field name collision", () => {
  test("skips auto-generated _i18n field when name already exists in schema", () => {
    const schema: SchemaDefinition = {
      name: "product",
      i18n: { defaultLocale: "en" },
      fields: {
        name: { type: "string", translatable: true, label: "Name" },
        // This field name collides with the auto-generated name_i18n
        name_i18n: { type: "string", label: "Custom i18n field" },
      },
    };

    const objectType = generateGraphQLObjectType(schema);
    const fields = objectType.getFields();

    // The name_i18n field should exist (from the schema definition)
    expect(fields.name_i18n).toBeDefined();

    // The resolver for name_i18n should use the schema-defined field (not the auto-generated one)
    // Resolve with a simple record to verify it uses the schema field resolver
    const result = fields.name_i18n.resolve?.(
      { name_i18n: "custom_value" },
      {},
      {} as any,
      {} as any,
    );
    expect(result).toBe("custom_value");
  });

  test("generates _i18n field when no collision exists", () => {
    const schema: SchemaDefinition = {
      name: "article",
      i18n: { defaultLocale: "en" },
      fields: {
        title: { type: "string", translatable: true, label: "Title" },
      },
    };

    const objectType = generateGraphQLObjectType(schema);
    const fields = objectType.getFields();

    // Both title and title_i18n should exist
    expect(fields.title).toBeDefined();
    expect(fields.title_i18n).toBeDefined();
  });
});
