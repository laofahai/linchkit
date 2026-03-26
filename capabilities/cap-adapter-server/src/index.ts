/**
 * @linchkit/cap-adapter-server — HTTP server
 *
 * Built on Elysia + graphql-yoga
 */

export const VERSION = "0.0.1";

export { capAdapterServer } from "./capability";

export type { FindManyOptions } from "@linchkit/core/server";
export { InMemoryStore } from "@linchkit/core/server";
export { generateGraphQLInputType, generateGraphQLObjectType } from "./graphql";
export type {
  BuildGraphQLSchemaOptions,
  GenerateCrudActionsOptions,
  GraphQLContext,
} from "./graphql/build-schema";
export { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
export {
  buildSubscriptionFields,
  buildTopic,
  createEventBusPubSub,
} from "./graphql/build-subscriptions";
export type { RuntimeContext, RuntimeContextOptions } from "./runtime-context";
export {
  SubscriptionManager,
  formatSSEEvent,
  parseSubscriptionQuery,
} from "./subscription-manager";
export type { SubscriptionEvent, SubscriptionFilter } from "./subscription-manager";
export { createRuntimeContext } from "./runtime-context";
export type { ServerOptions } from "./server";
export { createServer } from "./server";
