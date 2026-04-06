import { beforeEach, describe, expect, it } from "bun:test";
import { ConversationManager } from "../src/ai/conversation-manager";

describe("ConversationManager", () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager();
  });

  // ── getOrCreateSession ────────────────────────────────

  describe("getOrCreateSession", () => {
    it("creates a new session for a new actor", () => {
      const session = manager.getOrCreateSession("user-1");
      expect(session.id).toBeTruthy();
      expect(session.actorId).toBe("user-1");
      expect(session.messages).toEqual([]);
      expect(session.context).toEqual({});
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastActiveAt).toBeInstanceOf(Date);
    });

    it("returns the same session for the same actor", () => {
      const s1 = manager.getOrCreateSession("user-1");
      const s2 = manager.getOrCreateSession("user-1");
      expect(s1.id).toBe(s2.id);
    });

    it("creates separate sessions for different actors", () => {
      const s1 = manager.getOrCreateSession("user-1");
      const s2 = manager.getOrCreateSession("user-2");
      expect(s1.id).not.toBe(s2.id);
    });

    it("creates separate sessions for same actor in different tenants", () => {
      const s1 = manager.getOrCreateSession("user-1", "tenant-a");
      const s2 = manager.getOrCreateSession("user-1", "tenant-b");
      expect(s1.id).not.toBe(s2.id);
    });

    it("stores tenantId when provided", () => {
      const session = manager.getOrCreateSession("user-1", "tenant-a");
      expect(session.tenantId).toBe("tenant-a");
    });
  });

  // ── addMessage ────────────────────────────────────────

  describe("addMessage", () => {
    it("adds a message to the session", () => {
      const session = manager.getOrCreateSession("user-1");
      manager.addMessage(session.id, "user", "Hello");
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe("user");
      expect(session.messages[0].content).toBe("Hello");
      expect(session.messages[0].timestamp).toBeInstanceOf(Date);
    });

    it("does nothing for unknown session ID", () => {
      manager.addMessage("nonexistent", "user", "Hello");
      // no throw
    });

    it("respects maxMessages limit", () => {
      const mgr = new ConversationManager({ maxMessages: 3 });
      const session = mgr.getOrCreateSession("user-1");
      for (let i = 0; i < 5; i++) {
        mgr.addMessage(session.id, "user", `msg-${i}`);
      }
      expect(session.messages).toHaveLength(3);
      expect(session.messages[0].content).toBe("msg-2");
      expect(session.messages[2].content).toBe("msg-4");
    });

    it("trims by estimated token budget", () => {
      // maxHistoryTokens = 100 means ~400 chars
      const mgr = new ConversationManager({ maxMessages: 100, maxHistoryTokens: 100 });
      const session = mgr.getOrCreateSession("user-1");
      // Each message is ~200 chars = ~50 tokens
      const longMsg = "x".repeat(200);
      mgr.addMessage(session.id, "user", longMsg);
      mgr.addMessage(session.id, "assistant", longMsg);
      mgr.addMessage(session.id, "user", longMsg);
      // 600 chars / 4 = 150 tokens > 100, should trim
      expect(session.messages.length).toBeLessThan(3);
    });
  });

  // ── getSession ────────────────────────────────────────

  describe("getSession", () => {
    it("returns session by ID", () => {
      const created = manager.getOrCreateSession("user-1");
      const fetched = manager.getSession(created.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(created.id);
    });

    it("returns undefined for unknown ID", () => {
      expect(manager.getSession("nonexistent")).toBeUndefined();
    });

    it("returns undefined for expired session", () => {
      const mgr = new ConversationManager({ sessionTTL: 1 }); // 1ms TTL
      const session = mgr.getOrCreateSession("user-1");
      // Force expiry by manually setting lastActiveAt
      session.lastActiveAt = new Date(Date.now() - 100);
      expect(mgr.getSession(session.id)).toBeUndefined();
    });
  });

  // ── updateContext ──────────────────────────────────────

  describe("updateContext", () => {
    it("merges context fields", () => {
      const session = manager.getOrCreateSession("user-1");
      manager.updateContext(session.id, { schema: "purchase_order" });
      expect(session.context.schema).toBe("purchase_order");

      manager.updateContext(session.id, { recordId: "po-001" });
      expect(session.context.schema).toBe("purchase_order");
      expect(session.context.recordId).toBe("po-001");
    });

    it("does nothing for unknown session ID", () => {
      manager.updateContext("nonexistent", { schema: "test" });
      // no throw
    });
  });

  // ── cleanup ───────────────────────────────────────────

  describe("cleanup", () => {
    it("removes expired sessions", () => {
      const mgr = new ConversationManager({ sessionTTL: 1 }); // 1ms TTL
      const session = mgr.getOrCreateSession("user-1");
      session.lastActiveAt = new Date(Date.now() - 100);

      mgr.cleanup();
      expect(mgr.size).toBe(0);
    });

    it("keeps active sessions", () => {
      const mgr = new ConversationManager({ sessionTTL: 60_000 });
      mgr.getOrCreateSession("user-1");
      mgr.cleanup();
      expect(mgr.size).toBe(1);
    });
  });

  // ── size ──────────────────────────────────────────────

  describe("size", () => {
    it("tracks active session count", () => {
      expect(manager.size).toBe(0);
      manager.getOrCreateSession("user-1");
      expect(manager.size).toBe(1);
      manager.getOrCreateSession("user-2");
      expect(manager.size).toBe(2);
    });
  });
});
