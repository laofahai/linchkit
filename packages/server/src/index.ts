/**
 * @linchkit/server — HTTP server
 *
 * Built on Elysia + graphql-yoga
 */

export const VERSION = "0.0.1";

export { generateGraphQLObjectType, generateGraphQLInputType } from "./graphql";
export { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
export type { BuildGraphQLSchemaOptions } from "./graphql/build-schema";
export { createServer } from "./server";
export type { ServerOptions } from "./server";
export { InMemoryStore } from "./data/in-memory-store";
export type { FindManyOptions } from "./data/in-memory-store";
