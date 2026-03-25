/**
 * @linchkit/cap-adapter-server — HTTP server
 *
 * Built on Elysia + graphql-yoga
 */

export const VERSION = "0.0.1";

export { capAdapterServer } from "./capability";

export type { FindManyOptions } from "./data/in-memory-store";
export { InMemoryStore } from "./data/in-memory-store";
export { generateGraphQLInputType, generateGraphQLObjectType } from "./graphql";
export type { BuildGraphQLSchemaOptions, GraphQLContext } from "./graphql/build-schema";
export { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
export {
  buildSubscriptionFields,
  buildTopic,
  createEventBusPubSub,
} from "./graphql/build-subscriptions";
export type { RuntimeContext, RuntimeContextOptions } from "./runtime-context";
export { createRuntimeContext } from "./runtime-context";
export type { ServerOptions } from "./server";
export { createServer } from "./server";
