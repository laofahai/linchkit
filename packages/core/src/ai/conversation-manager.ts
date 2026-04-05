/**
 * Conversation Manager — Session management with TTL and context window.
 *
 * In-memory session storage for AI conversations. Supports sliding window
 * message retention and automatic cleanup of expired sessions.
 *
 * See spec 52 — AI Deep Integration, P2 Conversation Management.
 */

// ── Types ───────────────────────────────────────────────────

export interface AISessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface AISessionContext {
  schema?: string;
  recordId?: string;
  route?: string;
}

export interface AISession {
  id: string;
  actorId: string;
  tenantId?: string;
  messages: AISessionMessage[];
  context: AISessionContext;
  createdAt: Date;
  lastActiveAt: Date;
  historySummary?: string;
}

export interface ConversationManagerOptions {
  /** Session TTL in milliseconds (default: 30 minutes) */
  sessionTTL?: number;
  /** Maximum messages to retain per session (default: 20) */
  maxMessages?: number;
  /** Maximum estimated token budget for history (default: 8000) */
  maxHistoryTokens?: number;
}

// ── Default Values ──────────────────────────────────────────

const DEFAULT_SESSION_TTL = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_HISTORY_TOKENS = 8000;

// ── Conversation Manager ────────────────────────────────────

export class ConversationManager {
  private readonly sessions = new Map<string, AISession>();
  private readonly actorIndex = new Map<string, string>(); // actorId+tenantId → sessionId
  private readonly sessionTTL: number;
  private readonly maxMessages: number;
  private readonly maxHistoryTokens: number;

  constructor(options?: ConversationManagerOptions) {
    this.sessionTTL = options?.sessionTTL ?? DEFAULT_SESSION_TTL;
    this.maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxHistoryTokens = options?.maxHistoryTokens ?? DEFAULT_MAX_HISTORY_TOKENS;
  }

  /**
   * Get an existing session for the actor, or create a new one.
   */
  getOrCreateSession(actorId: string, tenantId?: string): AISession {
    const indexKey = this.buildIndexKey(actorId, tenantId);
    const existingId = this.actorIndex.get(indexKey);

    if (existingId) {
      const session = this.sessions.get(existingId);
      if (session && !this.isExpired(session)) {
        session.lastActiveAt = new Date();
        return session;
      }
      // Expired — remove stale references
      this.sessions.delete(existingId);
      this.actorIndex.delete(indexKey);
    }

    // Create new session
    const session: AISession = {
      id: crypto.randomUUID(),
      actorId,
      tenantId,
      messages: [],
      context: {},
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };

    this.sessions.set(session.id, session);
    this.actorIndex.set(indexKey, session.id);

    return session;
  }

  /**
   * Add a message to a session, enforcing sliding window limits.
   */
  addMessage(sessionId: string, role: "user" | "assistant", content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.messages.push({
      role,
      content,
      timestamp: new Date(),
    });

    session.lastActiveAt = new Date();

    // Enforce max messages
    this.trimMessages(session);
  }

  /**
   * Get a session by ID. Returns undefined if not found or expired.
   */
  getSession(sessionId: string): AISession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (this.isExpired(session)) {
      this.removeSession(sessionId);
      return undefined;
    }
    return session;
  }

  /**
   * Update the context for a session.
   */
  updateContext(sessionId: string, context: Partial<AISessionContext>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.context = { ...session.context, ...context };
    session.lastActiveAt = new Date();
  }

  /**
   * Remove expired sessions. Call periodically or before heavy operations.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt.getTime() > this.sessionTTL) {
        this.removeSession(id);
      }
    }
  }

  /**
   * Get the number of active sessions (for monitoring).
   */
  get size(): number {
    return this.sessions.size;
  }

  // ── Private ────────────────────────────────────────────

  private buildIndexKey(actorId: string, tenantId?: string): string {
    return tenantId ? `${actorId}::${tenantId}` : actorId;
  }

  private isExpired(session: AISession): boolean {
    return Date.now() - session.lastActiveAt.getTime() > this.sessionTTL;
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const indexKey = this.buildIndexKey(session.actorId, session.tenantId);
      this.actorIndex.delete(indexKey);
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Trim messages to stay within both count and estimated token limits.
   * Simple token estimation: characters / 4.
   */
  private trimMessages(session: AISession): void {
    // Trim by count first
    if (session.messages.length > this.maxMessages) {
      const excess = session.messages.length - this.maxMessages;
      session.messages.splice(0, excess);
    }

    // Trim by estimated token budget
    let totalTokens = this.estimateTokens(session.messages);
    while (session.messages.length > 1 && totalTokens > this.maxHistoryTokens) {
      session.messages.shift();
      totalTokens = this.estimateTokens(session.messages);
    }
  }

  private estimateTokens(messages: AISessionMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
      chars += msg.content.length;
    }
    return Math.ceil(chars / 4);
  }
}
