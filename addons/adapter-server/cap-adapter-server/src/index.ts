/**
 * @linchkit/cap-adapter-server — HTTP server
 *
 * Built on Elysia + graphql-yoga
 */

export const VERSION = "0.0.1";

export type { FindManyOptions } from "@linchkit/core/server";
export { InMemoryStore } from "@linchkit/core/server";
export type {
  AssembleDevSchemaOptions,
  AssembledDevSchema,
  CapabilityContributions,
} from "./assemble-schema";
export { assembleDevSchema, extractCapabilities } from "./assemble-schema";
export { capAdapterServer } from "./capability";
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
export { createRuntimeContext } from "./runtime-context";
export type { ServerOptions } from "./server";
export { createServer } from "./server";
export type { SubscriptionEvent, SubscriptionFilter } from "./subscription-manager";
export {
  formatSSEEvent,
  parseSubscriptionQuery,
  SubscriptionManager,
} from "./subscription-manager";
