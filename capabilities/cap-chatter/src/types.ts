/**
 * cap-chatter type definitions
 */

// ── Message types ───────────────────────────────────────────

export type MessageType = "comment" | "note" | "log" | "ai";

export interface ChatterMessage {
  id: string;
  tenantId?: string;
  schemaName: string;
  recordId: string;
  messageType: MessageType;
  body: string;
  bodyHtml?: string;
  authorId: string;
  authorType: string;
  authorName?: string;
  parentId?: string;
  threadCount: number;
  logEvent?: string;
  logMetadata?: Record<string, unknown>;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMessageInput {
  schemaName: string;
  recordId: string;
  messageType: MessageType;
  body: string;
  authorId: string;
  authorType?: string;
  authorName?: string;
  parentId?: string;
  logEvent?: string;
  logMetadata?: Record<string, unknown>;
  tenantId?: string;
}

export interface MessageQueryOptions {
  messageType?: MessageType;
  limit?: number;
  offset?: number;
  parentId?: string | null;
}

export interface PaginatedMessages {
  items: ChatterMessage[];
  totalCount: number;
  hasMore: boolean;
}

// ── Service interface ───────────────────────────────────────

export interface ChatterService {
  createMessage(input: CreateMessageInput): Promise<ChatterMessage>;
  getMessages(
    schemaName: string,
    recordId: string,
    options?: MessageQueryOptions,
  ): Promise<PaginatedMessages>;
}
