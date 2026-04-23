/**
 * cap-notification capability shape tests.
 */

import { describe, expect, it } from "bun:test";
import { capNotification } from "../src";

describe("capNotification", () => {
  it("declares the expected identity fields", () => {
    expect(capNotification.name).toBe("cap-notification");
    expect(capNotification.type).toBe("standard");
    expect(capNotification.category).toBe("system");
    expect(capNotification.version).toBe("0.0.1");
  });

  it("registers the notification entity", () => {
    const names = capNotification.entities?.map((e) => e.name);
    expect(names).toContain("notification");
  });

  it("registers all three write actions", () => {
    const names = capNotification.actions?.map((a) => a.name);
    expect(names).toEqual(
      expect.arrayContaining(["send_notification", "mark_notification_read", "mark_all_read"]),
    );
  });

  it("requests the system permissions needed to persist and emit", () => {
    expect(capNotification.systemPermissions).toEqual(
      expect.arrayContaining(["database.read", "database.write", "event.emit"]),
    );
  });
});
