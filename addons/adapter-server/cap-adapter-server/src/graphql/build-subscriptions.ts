/**
 * GraphQL Subscription support — wires EventBus to graphql-yoga PubSub.
 *
 * For each registered schema, generates subscription fields:
 *   - on{PascalName}Created: Type
 *   - on{PascalName}Updated: Type
 *   - on{PascalName}Deleted: DeletedRecord
 *
 * Uses graphql-yoga's built-in SSE-based subscription transport.
 */

import type { EntityDefinition, EventBus, EventRecord } from "@linchkit/core";
import {
  type GraphQLFieldConfig,
  GraphQLID,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import { createPubSub } from "graphql-yoga";
import { toPascalCase } from "./naming";

// ── PubSub topic naming ──────────────────────────────────

/** Build the PubSub topic name for an entity + operation */
export function buildTopic(
  entityName: string,
  operation: "created" | "updated" | "deleted",
): string {
  return `${entityName}.${operation}`;
}

// ── DeletedRecord type ───────────────────────────────────

const DeletedRecordType = new GraphQLObjectType({
  name: "DeletedRecord",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    schema: { type: new GraphQLNonNull(GraphQLString) },
  },
});

// ── PubSub + EventBus bridge ─────────────────────────────

/** PubSub event types — dynamic keys based on schema names */
type PubSubEvents = Record<string, [Record<string, unknown>]>;

/**
 * Create a PubSub instance and wire it to an EventBus.
 *
 * Listens for `record.created`, `record.updated`, `record.deleted` events
 * and publishes them to schema-specific PubSub topics.
 *
 * Returns the PubSub instance and an unsubscribe function to clean up listeners.
 */
export function createEventBusPubSub(eventBus: EventBus): {
  pubsub: ReturnType<typeof createPubSub<PubSubEvents>>;
  unsubscribe: () => void;
} {
  const pubsub = createPubSub<PubSubEvents>();

  const unsubscribers: Array<() => void> = [];

  // Map EventBus events → PubSub topics
  const eventMapping: Array<{ eventType: string; operation: "created" | "updated" | "deleted" }> = [
    { eventType: "record.created", operation: "created" },
    { eventType: "record.updated", operation: "updated" },
    { eventType: "record.deleted", operation: "deleted" },
  ];

  for (const { eventType, operation } of eventMapping) {
    const unsub = eventBus.subscribe(eventType, async (event: EventRecord) => {
      const entityName = event.entity;
      if (!entityName) return;

      const topic = buildTopic(entityName, operation);

      if (operation === "deleted") {
        pubsub.publish(topic, {
          id: event.recordId ?? event.payload.id,
          schema: entityName,
        });
      } else {
        // For created/updated, the payload typically contains the record data
        pubsub.publish(topic, {
          id: event.recordId ?? event.payload.id,
          schema: entityName,
          ...event.payload,
        });
      }
    });
    unsubscribers.push(unsub);
  }

  return {
    pubsub,
    unsubscribe: () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    },
  };
}

// ── Subscription field generation ────────────────────────

export interface BuildSubscriptionFieldsOptions {
  /** Entities to generate subscription fields for */
  entities: EntityDefinition[];
  /** Pre-generated GraphQL object types by entity name (reused from build-schema) */
  entityObjectTypes: Map<string, GraphQLObjectType>;
  /** PubSub instance wired to EventBus */
  pubsub: ReturnType<typeof createPubSub<PubSubEvents>>;
}

/**
 * Generate GraphQL subscription fields for all schemas.
 *
 * Returns a record of field configs suitable for use as
 * `new GraphQLObjectType({ name: "Subscription", fields: ... })`.
 */
export function buildSubscriptionFields(
  options: BuildSubscriptionFieldsOptions,
): Record<string, GraphQLFieldConfig<unknown, unknown>> | null {
  const { entities, entityObjectTypes, pubsub } = options;

  if (entities.length === 0) return null;

  const fields: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};

  for (const entity of entities) {
    const objectType = entityObjectTypes.get(entity.name);
    if (!objectType) continue;

    // PRODUCER side of the subscription field-name contract: the UI builds
    // these `on{Pascal}...` names independently via toPascalCase in
    // addons/adapter-ui/cap-adapter-ui/src/lib/api.ts (consumed by
    // buildEntitySubscriptionQuery in hooks/use-subscription.ts).
    const pascalName = toPascalCase(entity.name);
    const entityName = entity.name;

    // on{PascalName}Created
    fields[`on${pascalName}Created`] = {
      type: objectType,
      description: `Emitted when a new ${entity.label ?? entityName} record is created`,
      subscribe: () => pubsub.subscribe(buildTopic(entityName, "created")),
      resolve: (payload: unknown) => payload,
    };

    // on{PascalName}Updated
    fields[`on${pascalName}Updated`] = {
      type: objectType,
      description: `Emitted when a ${entity.label ?? entityName} record is updated`,
      subscribe: () => pubsub.subscribe(buildTopic(entityName, "updated")),
      resolve: (payload: unknown) => payload,
    };

    // on{PascalName}Deleted
    fields[`on${pascalName}Deleted`] = {
      type: DeletedRecordType,
      description: `Emitted when a ${entity.label ?? entityName} record is deleted`,
      subscribe: () => pubsub.subscribe(buildTopic(entityName, "deleted")),
      resolve: (payload: unknown) => payload,
    };
  }

  return Object.keys(fields).length > 0 ? fields : null;
}
