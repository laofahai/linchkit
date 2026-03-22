/**
 * GraphQL module — schema generation and type building
 */

export type { BuildGraphQLSchemaOptions } from "./build-schema";
export { buildGraphQLSchema, generateCrudActions } from "./build-schema";
export {
  generateActionInputType,
  generateGraphQLInputType,
  generateGraphQLObjectType,
} from "./schema-to-graphql";
