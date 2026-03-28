/**
 * ChatterService unit tests (InMemoryChatterService)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { InMemoryChatterService } from "../src/service";

describe("InMemoryChatterService", () => {
  let service: InMemoryChatterService;

  beforeEach(() => {
    service = new InMemoryChatterService();
  });

  describe("createMessage", () => {
    it("creates a message and returns it", async () => {
      const msg = await service.createMessage({
        schemaName: "purchase_request",
        recordId: "rec-001",
        messageType: "comment",
        body: "Hello, world!",
        authorId: "user-001",
      });

      expect(msg.id).toBeString();
      expect(msg.schemaName).toBe("purchase_request");
      expect(msg.recordId).toBe("rec-001");
      expect(msg.messageType).toBe("comment");
      expect(msg.body).toBe("Hello, world!");
      expect(msg.authorId).toBe("user-001");
      expect(msg.authorType).toBe("user");
      expect(msg.isDeleted).toBe(false);
      expect(msg.threadCount).toBe(0);
    });

    it("creates a log entry with metadata", async () => {
      const msg = await service.createMessage({
        schemaName: "purchase_request",
        recordId: "rec-001",
        messageType: "log",
        body: "Updated 1 field(s):\n- **amount**: 5000 → 8000",
        authorId: "system",
        authorType: "system",
        logEvent: "record.updated",
        logMetadata: {
          changed_fields: ["amount"],
          before: { amount: 5000 },
          after: { amount: 8000 },
        },
      });

      expect(msg.messageType).toBe("log");
      expect(msg.logEvent).toBe("record.updated");
      expect(msg.logMetadata).toEqual({
        changed_fields: ["amount"],
        before: { amount: 5000 },
        after: { amount: 8000 },
      });
    });

    it("assigns default authorType = 'user'", async () => {
      const msg = await service.createMessage({
        schemaName: "s",
        recordId: "r",
        messageType: "comment",
        body: "test",
        authorId: "u1",
      });
      expect(msg.authorType).toBe("user");
    });

    it("stores tenantId when provided", async () => {
      const msg = await service.createMessage({
        schemaName: "s",
        recordId: "r",
        messageType: "comment",
        body: "test",
        authorId: "u1",
        tenantId: "tenant-abc",
      });
      expect(msg.tenantId).toBe("tenant-abc");
    });
  });

  describe("getMessages", () => {
    it("returns messages for the given record", async () => {
      await service.createMessage({
        schemaName: "purchase_request",
        recordId: "rec-001",
        messageType: "comment",
        body: "First comment",
        authorId: "user-001",
      });
      await service.createMessage({
        schemaName: "purchase_request",
        recordId: "rec-001",
        messageType: "log",
        body: "Created this record.",
        authorId: "system",
        authorType: "system",
      });
      await service.createMessage({
        schemaName: "purchase_request",
        recordId: "rec-002",
        messageType: "comment",
        body: "Different record",
        authorId: "user-001",
      });

      const result = await service.getMessages("purchase_request", "rec-001");
      expect(result.totalCount).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(false);
    });

    it("filters by messageType", async () => {
      await service.createMessage({ schemaName: "s", recordId: "r", messageType: "comment", body: "c", authorId: "u" });
      await service.createMessage({ schemaName: "s", recordId: "r", messageType: "log", body: "l", authorId: "sys", authorType: "system" });

      const comments = await service.getMessages("s", "r", { messageType: "comment" });
      expect(comments.totalCount).toBe(1);
      expect(comments.items[0].messageType).toBe("comment");

      const logs = await service.getMessages("s", "r", { messageType: "log" });
      expect(logs.totalCount).toBe(1);
      expect(logs.items[0].messageType).toBe("log");
    });

    it("paginates correctly", async () => {
      for (let i = 0; i < 5; i++) {
        await service.createMessage({
          schemaName: "s",
          recordId: "r",
          messageType: "comment",
          body: `Message ${i}`,
          authorId: "u",
        });
      }

      const page1 = await service.getMessages("s", "r", { limit: 3, offset: 0 });
      expect(page1.totalCount).toBe(5);
      expect(page1.items).toHaveLength(3);
      expect(page1.hasMore).toBe(true);

      const page2 = await service.getMessages("s", "r", { limit: 3, offset: 3 });
      expect(page2.items).toHaveLength(2);
      expect(page2.hasMore).toBe(false);
    });

    it("returns empty result for unknown record", async () => {
      const result = await service.getMessages("s", "nonexistent");
      expect(result.totalCount).toBe(0);
      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });
  });
});
