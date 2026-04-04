import { describe, expect, it } from "bun:test";
import { capAuth } from "../src/capability";

describe("cap-auth capability (static contract)", () => {
  it("should have correct metadata", () => {
    expect(capAuth.name).toBe("cap-auth");
    expect(capAuth.type).toBe("standard");
    expect(capAuth.category).toBe("system");
    expect(capAuth.version).toBe("0.0.1");
  });

  it("should define 4 schemas", () => {
    expect(capAuth.entities).toHaveLength(4);
    const names = capAuth.entities?.map((s) => s.name) ?? [];
    expect(names).toContain("user");
    expect(names).toContain("session");
    expect(names).toContain("api_key");
    expect(names).toContain("token");
  });

  it("should define 5 actions without handlers (pure contract)", () => {
    expect(capAuth.actions).toHaveLength(5);
    const names = capAuth.actions?.map((a) => a.name) ?? [];
    expect(names).toContain("login");
    expect(names).toContain("logout");
    expect(names).toContain("create_api_key");
    expect(names).toContain("refresh_token");
    expect(names).toContain("reset_password");

    // All actions should have NO handler (pure contract)
    for (const action of capAuth.actions ?? []) {
      expect(action.handler).toBeUndefined();
    }
  });

  it("should define user_lifecycle state machine", () => {
    expect(capAuth.states).toHaveLength(1);
    const state = capAuth.states?.[0];
    expect(state).toBeDefined();
    if (!state) return;
    expect(state.name).toBe("user_lifecycle");
    expect(state.entity).toBe("user");
    expect(state.initial).toBe("active");
    expect(state.states).toContain("active");
    expect(state.states).toContain("disabled");
    expect(state.states).toContain("locked");
  });

  it("should declare system permissions with dot notation", () => {
    expect(capAuth.systemPermissions).toContain("database.read");
    expect(capAuth.systemPermissions).toContain("database.write");
    expect(capAuth.systemPermissions).toContain("event.emit");
  });
});
