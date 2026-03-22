/**
 * Schema-to-GraphQL generator
 *
 * Converts a LinchKit SchemaDefinition into GraphQL object and input types
 * for use in a GraphQL API layer.
 */

import type { ActionDefinition, FieldDefinition, SchemaDefinition } from "@linchkit/core";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  type GraphQLInputFieldConfig,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
} from "graphql";

// Field types that are virtual and should not produce GraphQL fields
const SKIPPED_FIELD_TYPES = new Set(["computed", "has_many", "many_to_many"]);

/**
 * Map a LinchKit field type to a GraphQL output type.
 */
function mapFieldToGraphQLType(field: FieldDefinition): GraphQLOutputType | null {
  switch (field.type) {
    case "string":
    case "text":
    case "date":
    case "datetime":
    case "enum":
    case "state":
      return GraphQLString;
    case "number":
      return GraphQLFloat;
    case "boolean":
      return GraphQLBoolean;
    case "json":
      // JSON fields are represented as String (serialized JSON)
      return GraphQLString;
    case "ref":
      // References are stored as ID strings
      return GraphQLString;
    default:
      return null;
  }
}

/**
 * Map a LinchKit field type to a GraphQL input type.
 */
export function mapFieldToGraphQLInputType(field: FieldDefinition): GraphQLInputType | null {
  switch (field.type) {
    case "string":
    case "text":
    case "date":
    case "datetime":
    case "enum":
    case "state":
      return GraphQLString;
    case "number":
      return GraphQLFloat;
    case "boolean":
      return GraphQLBoolean;
    case "json":
      return GraphQLString;
    case "ref":
      return GraphQLString;
    default:
      return null;
  }
}

/** Regex for valid GraphQL names */
const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/**
 * Convert a schema name to PascalCase for GraphQL type naming.
 * Strips illegal characters and validates the result.
 * e.g. "order_item" → "OrderItem"
 */
function toPascalCase(name: string): string {
  const raw = name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  // Strip characters not allowed in GraphQL names
  const sanitized = raw.replace(/[^_0-9A-Za-z]/g, "");

  // Ensure name starts with a letter or underscore
  const result = GRAPHQL_NAME_RE.test(sanitized) ? sanitized : `_${sanitized}`;

  if (result !== raw) {
    console.warn(
      `[schema-to-graphql] Name "${name}" sanitized to "${result}" for GraphQL compatibility`,
    );
  }

  return result;
}

/**
 * Generate a GraphQL object type from a LinchKit SchemaDefinition.
 * Includes system fields (id, tenant_id, created_at, etc.) and user-defined fields.
 */
export function generateGraphQLObjectType(schema: SchemaDefinition): GraphQLObjectType {
  const typeName = toPascalCase(schema.name);

  return new GraphQLObjectType({
    name: typeName,
    description: schema.description ?? schema.label,
    fields: () => {
      const fields: Record<
        string,
        {
          type: GraphQLOutputType;
          description?: string;
          resolve?: (obj: Record<string, unknown>) => unknown;
        }
      > = {};

      // System fields — use safe resolvers to handle missing values
      fields.id = {
        type: new GraphQLNonNull(GraphQLID),
        resolve: (obj: Record<string, unknown>) => obj.id ?? "",
      };
      fields.tenant_id = {
        type: GraphQLString,
        resolve: (obj: Record<string, unknown>) => obj.tenant_id ?? null,
      };
      fields.created_at = {
        type: new GraphQLNonNull(GraphQLString),
        description: "ISO 8601 timestamp",
        resolve: (obj: Record<string, unknown>) => obj.created_at ?? new Date().toISOString(),
      };
      fields.updated_at = {
        type: new GraphQLNonNull(GraphQLString),
        description: "ISO 8601 timestamp",
        resolve: (obj: Record<string, unknown>) => obj.updated_at ?? new Date().toISOString(),
      };
      fields.created_by = {
        type: GraphQLString,
        resolve: (obj: Record<string, unknown>) => obj.created_by ?? null,
      };
      fields.updated_by = {
        type: GraphQLString,
        resolve: (obj: Record<string, unknown>) => obj.updated_by ?? null,
      };
      fields._version = {
        type: new GraphQLNonNull(GraphQLInt),
        resolve: (obj: Record<string, unknown>) => obj._version ?? 1,
      };

      // User-defined fields — always nullable in output with safe resolvers
      // to prevent crashes when records are missing fields
      for (const [fieldName, field] of Object.entries(schema.fields)) {
        if (SKIPPED_FIELD_TYPES.has(field.type)) {
          continue;
        }

        const graphqlType = mapFieldToGraphQLType(field);
        if (!graphqlType) {
          continue;
        }

        const name = fieldName;
        fields[fieldName] = {
          type: graphqlType, // Always nullable in output to prevent resolver crashes
          description: field.description ?? field.label,
          resolve: (obj: Record<string, unknown>) => obj[name] ?? null,
        };
      }

      return fields;
    },
  });
}

/**
 * Generate a GraphQL input type from a LinchKit SchemaDefinition.
 * Excludes system fields — those are managed by the server.
 */
export function generateGraphQLInputType(schema: SchemaDefinition): GraphQLInputObjectType {
  const typeName = `${toPascalCase(schema.name)}Input`;

  return new GraphQLInputObjectType({
    name: typeName,
    description: `Input type for creating/updating ${schema.label ?? schema.name}`,
    fields: () => {
      const fields: Record<string, GraphQLInputFieldConfig> = {};

      for (const [fieldName, field] of Object.entries(schema.fields)) {
        if (SKIPPED_FIELD_TYPES.has(field.type)) {
          continue;
        }

        const graphqlType = mapFieldToGraphQLInputType(field);
        if (!graphqlType) {
          continue;
        }

        fields[fieldName] = {
          type: field.required ? new GraphQLNonNull(graphqlType) : graphqlType,
          description: field.description ?? field.label,
        };
      }

      return fields;
    },
  });
}

/**
 * Generate a GraphQL input type from an ActionDefinition's input fields.
 * Returns null if the action has no input definition.
 */
export function generateActionInputType(action: ActionDefinition): GraphQLInputObjectType | null {
  if (!action.input || Object.keys(action.input).length === 0) {
    return null;
  }

  const typeName = `${toPascalCase(action.name)}Input`;

  return new GraphQLInputObjectType({
    name: typeName,
    description: `Input type for ${action.label ?? action.name}`,
    fields: () => {
      const fields: Record<string, GraphQLInputFieldConfig> = {};

      const inputFields = action.input ?? {};
      for (const [fieldName, field] of Object.entries(inputFields)) {
        if (SKIPPED_FIELD_TYPES.has(field.type)) {
          continue;
        }

        const graphqlType = mapFieldToGraphQLInputType(field);
        if (!graphqlType) {
          continue;
        }

        fields[fieldName] = {
          type: field.required ? new GraphQLNonNull(graphqlType) : graphqlType,
          description: field.description ?? field.label,
        };
      }

      return fields;
    },
  });
}
