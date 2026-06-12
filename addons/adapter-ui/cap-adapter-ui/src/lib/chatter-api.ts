/**
 * Chatter timeline API client — query and post messages to record timelines.
 */

import { type GraphQLResponse, graphql } from "./api";

function throwOnErrors(res: GraphQLResponse): void {
  const errors = res.errors;
  if (errors && errors.length > 0) {
    const firstError = errors.at(0);
    throw new Error(firstError?.message ?? "Unknown GraphQL error");
  }
}

export interface ChatterMessageAuthor {
  id: string;
  type: string; // 'user' | 'system' | 'ai'
  name?: string | null;
}

export type ChatterMessageType = "comment" | "note" | "log" | "ai";

export interface ChatterMessage {
  id: string;
  entityName: string;
  recordId: string;
  messageType: ChatterMessageType;
  body: string;
  author: ChatterMessageAuthor;
  logEvent?: string | null;
  logMetadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatterMessageConnection {
  items: ChatterMessage[];
  totalCount: number;
  hasMore: boolean;
}

const CHATTER_MESSAGE_FIELDS = `
  id entityName recordId messageType body
  author { id type name }
  logEvent logMetadata
  createdAt updatedAt
`;

/**
 * Query chatter messages for a record.
 * Returns empty connection gracefully when cap-chatter is not installed.
 */
export async function queryChatterMessages(
  entityName: string,
  recordId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ChatterMessageConnection> {
  const query = `
    query ChatterMessages($entityName: String!, $recordId: String!, $limit: Int, $offset: Int) {
      chatterMessages(entityName: $entityName, recordId: $recordId, limit: $limit, offset: $offset) {
        items { ${CHATTER_MESSAGE_FIELDS} }
        totalCount
        hasMore
      }
    }
  `;
  const res = await graphql<{ chatterMessages: ChatterMessageConnection }>(query, {
    entityName,
    recordId,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
  });
  // Graceful fallback only for the "cap-chatter not installed" case (unresolved
  // field). Auth errors, permission failures, and server regressions must surface.
  if (res.errors && res.errors.length > 0) {
    const isMissingCapability = res.errors.some((e) =>
      e.message.toLowerCase().includes("chattermessages"),
    );
    if (!isMissingCapability) {
      throw new Error(res.errors[0]?.message ?? "GraphQL error");
    }
    return { items: [], totalCount: 0, hasMore: false };
  }
  return res.data?.chatterMessages ?? { items: [], totalCount: 0, hasMore: false };
}

/**
 * Post a comment or note to a record's chatter timeline.
 */
export async function addChatterMessage(
  entityName: string,
  recordId: string,
  messageType: "comment" | "note",
  body: string,
): Promise<ChatterMessage> {
  const query = `
    mutation AddChatterMessage($entityName: String!, $recordId: String!, $messageType: MessageType!, $body: String!) {
      chatterAddMessage(entityName: $entityName, recordId: $recordId, messageType: $messageType, body: $body) {
        ${CHATTER_MESSAGE_FIELDS}
      }
    }
  `;
  const res = await graphql<{ chatterAddMessage: ChatterMessage }>(query, {
    entityName,
    recordId,
    messageType,
    body,
  });
  throwOnErrors(res);
  const result = res.data?.chatterAddMessage;
  if (!result) throw new Error("No data returned");
  return result;
}
