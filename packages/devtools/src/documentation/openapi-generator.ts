/**
 * OpenAPI 3.0 Generator
 *
 * Generates an OpenAPI 3.0 specification from EntityDefinitions and ActionDefinitions
 * via the structured SystemDoc intermediate representation.
 */

import type { ActionDoc, EntityDoc, FieldDoc, SystemDoc } from "./api-doc-generator";

// -- OpenAPI types (subset of OpenAPI 3.0) -------------------------------------------------

export interface OpenAPISpec {
  openapi: "3.0.3";
  info: {
    title: string;
    description?: string;
    version: string;
  };
  paths: Record<string, OpenAPIPathItem>;
  components: {
    schemas: Record<string, OpenAPISchemaObject>;
  };
}

export interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  delete?: OpenAPIOperation;
}

export interface OpenAPIOperation {
  summary: string;
  description?: string;
  operationId: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: {
    required: boolean;
    content: {
      "application/json": {
        schema: OpenAPISchemaRef;
      };
    };
  };
  responses: Record<string, OpenAPIResponse>;
}

export interface OpenAPIParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: OpenAPISchemaRef;
  description?: string;
}

export interface OpenAPIResponse {
  description: string;
  content?: {
    "application/json": {
      schema: OpenAPISchemaRef;
    };
  };
}

export type OpenAPISchemaRef = { $ref: string } | OpenAPISchemaObject;

export interface OpenAPISchemaObject {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, OpenAPISchemaRef>;
  required?: string[];
  items?: OpenAPISchemaRef;
  enum?: string[];
  nullable?: boolean;
  additionalProperties?: boolean | OpenAPISchemaRef;
}

// -- Field type mapping -------------------------------------------------

/** Map LinchKit field types to OpenAPI type + format */
function fieldTypeToOpenAPI(field: FieldDoc): OpenAPISchemaRef {
  switch (field.type) {
    case "string":
      return { type: "string" };
    case "text":
      return { type: "string", format: "text" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "enum":
      return {
        type: "string",
        enum: field.options?.map((o) => o.value),
      };
    case "json":
      return { type: "object", additionalProperties: true };
    case "state":
      return { type: "string", description: `State machine: ${field.machine ?? "unknown"}` };
    case "computed":
      return { type: "string", description: "Computed field" };
    case "ref":
      return { type: "string", format: "uuid", description: `Reference to ${field.target}` };
    case "has_many":
      return {
        type: "array",
        items: { type: "string", format: "uuid" },
        description: `References to ${field.target}`,
      };
    case "many_to_many":
      return {
        type: "array",
        items: { type: "string", format: "uuid" },
        description: `Many-to-many with ${field.target}`,
      };
    default:
      return { type: "string" };
  }
}

// -- Schema generation -------------------------------------------------

/** Generate an OpenAPI component schema from an EntityDoc */
function schemaDocToOpenAPISchema(schema: EntityDoc): OpenAPISchemaObject {
  const properties: Record<string, OpenAPISchemaRef> = {};
  const required: string[] = [];

  // System fields
  properties.id = { type: "string", format: "uuid" };
  properties.created_at = { type: "string", format: "date-time" };
  properties.updated_at = { type: "string", format: "date-time" };

  for (const field of schema.fields) {
    properties[field.name] = fieldTypeToOpenAPI(field);
    if (field.required) {
      required.push(field.name);
    }
  }

  return {
    type: "object",
    description: schema.description,
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/** Generate an input schema for an EntityDoc (for create/update) */
function schemaDocToInputSchema(schema: EntityDoc): OpenAPISchemaObject {
  const properties: Record<string, OpenAPISchemaRef> = {};
  const required: string[] = [];

  for (const field of schema.fields) {
    // Skip computed fields (not directly writable)
    if (field.type === "computed") {
      continue;
    }
    properties[field.name] = fieldTypeToOpenAPI(field);
    if (field.required) {
      required.push(field.name);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/** Generate an input schema for an action */
function actionInputSchema(action: ActionDoc): OpenAPISchemaObject {
  const properties: Record<string, OpenAPISchemaRef> = {};
  const required: string[] = [];

  for (const field of action.input) {
    properties[field.name] = fieldTypeToOpenAPI(field);
    if (field.required) {
      required.push(field.name);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

// -- Path generation -------------------------------------------------

/** Generate CRUD paths for an entity */
function generateCRUDPaths(schema: EntityDoc): Record<string, OpenAPIPathItem> {
  const paths: Record<string, OpenAPIPathItem> = {};
  const tag = schema.label;
  const basePath = `/api/${schema.name}`;
  const componentRef = `#/components/schemas/${schema.name}`;
  const inputRef = `#/components/schemas/${schema.name}_input`;

  // List + Create
  paths[basePath] = {
    get: {
      summary: `List ${schema.label}`,
      operationId: `list_${schema.name}`,
      tags: [tag],
      parameters: [
        { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        { name: "offset", in: "query", required: false, schema: { type: "integer" } },
      ],
      responses: {
        "200": {
          description: `List of ${schema.label}`,
          content: {
            "application/json": {
              schema: { type: "array", items: { $ref: componentRef } },
            },
          },
        },
      },
    },
    post: {
      summary: `Create ${schema.label}`,
      operationId: `create_${schema.name}`,
      tags: [tag],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: inputRef } } },
      },
      responses: {
        "201": {
          description: `Created ${schema.label}`,
          content: { "application/json": { schema: { $ref: componentRef } } },
        },
        "400": { description: "Validation error" },
      },
    },
  };

  // Get + Update + Delete by ID
  paths[`${basePath}/{id}`] = {
    get: {
      summary: `Get ${schema.label} by ID`,
      operationId: `get_${schema.name}`,
      tags: [tag],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "200": {
          description: schema.label,
          content: { "application/json": { schema: { $ref: componentRef } } },
        },
        "404": { description: "Not found" },
      },
    },
    put: {
      summary: `Update ${schema.label}`,
      operationId: `update_${schema.name}`,
      tags: [tag],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: inputRef } } },
      },
      responses: {
        "200": {
          description: `Updated ${schema.label}`,
          content: { "application/json": { schema: { $ref: componentRef } } },
        },
        "400": { description: "Validation error" },
        "404": { description: "Not found" },
      },
    },
    delete: {
      summary: `Delete ${schema.label}`,
      operationId: `delete_${schema.name}`,
      tags: [tag],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "204": { description: "Deleted" },
        "404": { description: "Not found" },
      },
    },
  };

  return paths;
}

/** Generate action endpoint path */
function generateActionPath(action: ActionDoc): Record<string, OpenAPIPathItem> {
  // Only generate for actions exposed via HTTP
  if (!action.exposure.http) return {};

  const path = `/api/actions/${action.name}`;
  const inputSchemaName = `${action.name}_input`;

  return {
    [path]: {
      post: {
        summary: action.label,
        description: action.description,
        operationId: action.name,
        tags: [action.entity],
        requestBody:
          action.input.length > 0
            ? {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/${inputSchemaName}` },
                  },
                },
              }
            : undefined,
        responses: {
          "200": {
            description: "Action result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { type: "object", additionalProperties: true },
                    executionId: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Validation error" },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden" },
          "422": { description: "Business error" },
        },
      },
    },
  };
}

// -- Public API -------------------------------------------------

export interface OpenAPIGeneratorOptions {
  /** API version string. Default: "1.0.0" */
  version?: string;
  /** Include CRUD endpoints for each schema. Default: true */
  crud?: boolean;
  /** Include action endpoints. Default: true */
  actions?: boolean;
}

/**
 * Generate an OpenAPI 3.0 specification from a SystemDoc.
 */
export function generateOpenAPISpec(
  doc: SystemDoc,
  options?: OpenAPIGeneratorOptions,
): OpenAPISpec {
  const opts = {
    version: "1.0.0",
    crud: true,
    actions: true,
    ...options,
  };

  const paths: Record<string, OpenAPIPathItem> = {};
  const components: Record<string, OpenAPISchemaObject> = {};

  for (const schema of doc.entities) {
    // Component schemas
    components[schema.name] = schemaDocToOpenAPISchema(schema);
    components[`${schema.name}_input`] = schemaDocToInputSchema(schema);

    // CRUD paths
    if (opts.crud) {
      Object.assign(paths, generateCRUDPaths(schema));
    }

    // Action paths + input schemas
    if (opts.actions) {
      for (const action of schema.actions) {
        Object.assign(paths, generateActionPath(action));
        if (action.input.length > 0) {
          components[`${action.name}_input`] = actionInputSchema(action);
        }
      }
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: doc.title,
      description: doc.description,
      version: opts.version,
    },
    paths,
    components: { schemas: components },
  };
}
