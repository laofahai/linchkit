/**
 * ChatterService — message storage and retrieval
 *
 * Two implementations:
 * - InMemoryChatterService: for testing and non-DB environments
 * - DrizzleChatterService: for PostgreSQL environments
 */

import type {
  ChatterMessage,
  ChatterService,
  CreateMessageInput,
  MessageQueryOptions,
  PaginatedMessages,
} from "./types";

// ── Shared helpers ──────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

// ── InMemoryChatterService ──────────────────────────────────

export class InMemoryChatterService implements ChatterService {
  private messages: ChatterMessage[] = [];

  async createMessage(input: CreateMessageInput): Promise<ChatterMessage> {
    const msg: ChatterMessage = {
      id: generateId(),
      tenantId: input.tenantId,
      schemaName: input.schemaName,
      recordId: input.recordId,
      messageType: input.messageType,
      body: input.body,
      authorId: input.authorId,
      authorType: input.authorType ?? "user",
      authorName: input.authorName,
      parentId: input.parentId,
      threadCount: 0,
      logEvent: input.logEvent,
      logMetadata: input.logMetadata,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.messages.push(msg);
    return msg;
  }

  async getMessages(
    schemaName: string,
    recordId: string,
    options?: MessageQueryOptions,
  ): Promise<PaginatedMessages> {
    const { messageType, limit = 20, offset = 0, parentId } = options ?? {};

    let filtered = this.messages.filter(
      (m) =>
        m.schemaName === schemaName &&
        m.recordId === recordId &&
        !m.isDeleted &&
        (parentId === undefined
          ? m.parentId === undefined
          : m.parentId === (parentId ?? undefined)),
    );

    if (messageType !== undefined) {
      filtered = filtered.filter((m) => m.messageType === messageType);
    }

    // Sort by createdAt ascending
    filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const totalCount = filtered.length;
    const items = filtered.slice(offset, offset + limit);

    return {
      items,
      totalCount,
      hasMore: offset + limit < totalCount,
    };
  }

  /** Test helper: reset all messages */
  clear(): void {
    this.messages = [];
  }
}

// ── DrizzleChatterService ───────────────────────────────────

export class DrizzleChatterService implements ChatterService {
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB instance
  constructor(private readonly db: any) {}

  async createMessage(input: CreateMessageInput): Promise<ChatterMessage> {
    const { messagesTable } = await import("./tables");
    const [row] = await this.db
      .insert(messagesTable)
      .values({
        tenantId: input.tenantId,
        schemaName: input.schemaName,
        recordId: input.recordId,
        messageType: input.messageType,
        body: input.body,
        authorId: input.authorId,
        authorType: input.authorType ?? "user",
        authorName: input.authorName,
        parentId: input.parentId,
        logEvent: input.logEvent,
        logMetadata: input.logMetadata,
      })
      .returning();

    return rowToMessage(row);
  }

  async getMessages(
    schemaName: string,
    recordId: string,
    options?: MessageQueryOptions,
  ): Promise<PaginatedMessages> {
    const { messagesTable } = await import("./tables");
    const { and, asc, count, eq, isNull } = await import("drizzle-orm");

    const { messageType, limit = 20, offset = 0 } = options ?? {};

    const conditions = [
      eq(messagesTable.schemaName, schemaName),
      eq(messagesTable.recordId, recordId),
      eq(messagesTable.isDeleted, false),
      // Top-level messages only (no parentId)
      isNull(messagesTable.parentId),
    ];

    if (messageType !== undefined) {
      conditions.push(eq(messagesTable.messageType, messageType));
    }

    const where = and(...conditions);

    const [{ value: totalCount }] = await this.db
      .select({ value: count() })
      .from(messagesTable)
      .where(where);

    const rows = await this.db
      .select()
      .from(messagesTable)
      .where(where)
      .orderBy(asc(messagesTable.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map(rowToMessage),
      totalCount: Number(totalCount),
      hasMore: offset + limit < Number(totalCount),
    };
  }
}

// ── Row → domain object ─────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: Drizzle row type
function rowToMessage(row: any): ChatterMessage {
  return {
    id: row.id,
    tenantId: row.tenantId ?? undefined,
    schemaName: row.schemaName,
    recordId: row.recordId,
    messageType: row.messageType,
    body: row.body,
    bodyHtml: row.bodyHtml ?? undefined,
    authorId: row.authorId,
    authorType: row.authorType,
    authorName: row.authorName ?? undefined,
    parentId: row.parentId ?? undefined,
    threadCount: row.threadCount ?? 0,
    logEvent: row.logEvent ?? undefined,
    logMetadata: row.logMetadata ?? undefined,
    isDeleted: row.isDeleted,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
