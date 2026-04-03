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

import type { EventBus, EventRecord, EntityDefinition } from "@linchkit/core";
import {
  type GraphQLFieldConfig,
  GraphQLID,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import { createPubSub } from "graphql-yoga";

// ── PubSub topic naming ──────────────────────────────────

/** Build the PubSub topic name for a schema + operation */
export function buildTopic(
  schemaName: string,
  operation: "created" | "updated" | "deleted",
): string {
  return `${schemaName}.${operation}`;
}

// ── DeletedRecord type ───────────────────────────────────

const DeletedRecordType = new GraphQLObjectType({
  name: "DeletedRecord",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    schema: { type: new GraphQLNonNull(GraphQLString) },
  },
});

// ── PascalCase helper (same as build-schema.ts) ──────────

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

function toPascalCase(name: string): string {
  const raw = name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const sanitized = raw.replace(/[^_0-9A-Za-z]/g, "");
  return GRAPHQL_NAME_RE.test(sanitized) ? sanitized : `_${sanitized}`;
}

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
      const schemaName = event.schema;
      if (!schemaName) return;

      const topic = buildTopic(schemaName, operation);

      if (operation === "deleted") {
        pubsub.publish(topic, {
          id: event.recordId ?? event.payload.id,
          schema: schemaName,
        });
      } else {
        // For created/updated, the payload typically contains the record data
        pubsub.publish(topic, {
          id: event.recordId ?? event.payload.id,
          schema: schemaName,
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
  /** Schemas to generate subscription fields for */
  schemas: EntityDefinition[];
  /** Pre-generated GraphQL object types by schema name (reused from build-schema) */
  schemaObjectTypes: Map<string, GraphQLObjectType>;
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
  const { schemas, schemaObjectTypes, pubsub } = options;

  if (schemas.length === 0) return null;

  const fields: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};

  for (const schema of schemas) {
    const objectType = schemaObjectTypes.get(schema.name);
    if (!objectType) continue;

    const pascalName = toPascalCase(schema.name);
    const schemaName = schema.name;

    // on{PascalName}Created
    fields[`on${pascalName}Created`] = {
      type: objectType,
      description: `Emitted when a new ${schema.label ?? schemaName} record is created`,
      subscribe: () => pubsub.subscribe(buildTopic(schemaName, "created")),
      resolve: (payload: unknown) => payload,
    };

    // on{PascalName}Updated
    fields[`on${pascalName}Updated`] = {
      type: objectType,
      description: `Emitted when a ${schema.label ?? schemaName} record is updated`,
      subscribe: () => pubsub.subscribe(buildTopic(schemaName, "updated")),
      resolve: (payload: unknown) => payload,
    };

    // on{PascalName}Deleted
    fields[`on${pascalName}Deleted`] = {
      type: DeletedRecordType,
      description: `Emitted when a ${schema.label ?? schemaName} record is deleted`,
      subscribe: () => pubsub.subscribe(buildTopic(schemaName, "deleted")),
      resolve: (payload: unknown) => payload,
    };
  }

  return Object.keys(fields).length > 0 ? fields : null;
}
