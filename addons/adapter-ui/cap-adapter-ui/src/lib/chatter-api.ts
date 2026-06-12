import { graphql, throwOnErrors } from "./graphql";

export interface ChatterMessageAuthor {
  id: string;
  type: string;
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
  // Graceful fallback: if cap-chatter not installed, return empty
  if (res.errors && res.errors.length > 0) {
    return { items: [], totalCount: 0, hasMore: false };
  }
  return res.data?.chatterMessages ?? { items: [], totalCount: 0, hasMore: false };
}

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
