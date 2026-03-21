/**
 * Schema-to-GraphQL generator
 *
 * Converts a LinchKit SchemaDefinition into GraphQL object and input types
 * for use in a GraphQL API layer.
 */

import {
	GraphQLBoolean,
	GraphQLFloat,
	GraphQLID,
	GraphQLInputObjectType,
	GraphQLInt,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLString,
	type GraphQLInputFieldConfig,
	type GraphQLOutputType,
	type GraphQLInputType,
} from "graphql";
import type { FieldDefinition, SchemaDefinition } from "@linchkit/core";

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
function mapFieldToGraphQLInputType(field: FieldDefinition): GraphQLInputType | null {
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

/**
 * Convert a schema name to PascalCase for GraphQL type naming.
 * e.g. "order_item" → "OrderItem"
 */
function toPascalCase(name: string): string {
	return name
		.split(/[_-]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/**
 * Generate a GraphQL object type from a LinchKit SchemaDefinition.
 * Includes system fields (id, tenant_id, created_at, etc.) and user-defined fields.
 */
export function generateGraphQLObjectType(
	schema: SchemaDefinition,
): GraphQLObjectType {
	const typeName = toPascalCase(schema.name);

	return new GraphQLObjectType({
		name: typeName,
		description: schema.description ?? schema.label,
		fields: () => {
			const fields: Record<string, { type: GraphQLOutputType; description?: string }> = {};

			// System fields
			fields.id = { type: new GraphQLNonNull(GraphQLID) };
			fields.tenant_id = { type: GraphQLString };
			fields.created_at = { type: new GraphQLNonNull(GraphQLString), description: "ISO 8601 timestamp" };
			fields.updated_at = { type: new GraphQLNonNull(GraphQLString), description: "ISO 8601 timestamp" };
			fields.created_by = { type: GraphQLString };
			fields.updated_by = { type: GraphQLString };
			fields._version = { type: new GraphQLNonNull(GraphQLInt) };

			// User-defined fields
			for (const [fieldName, field] of Object.entries(schema.fields)) {
				if (SKIPPED_FIELD_TYPES.has(field.type)) {
					continue;
				}

				const graphqlType = mapFieldToGraphQLType(field);
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
 * Generate a GraphQL input type from a LinchKit SchemaDefinition.
 * Excludes system fields — those are managed by the server.
 */
export function generateGraphQLInputType(
	schema: SchemaDefinition,
): GraphQLInputObjectType {
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
