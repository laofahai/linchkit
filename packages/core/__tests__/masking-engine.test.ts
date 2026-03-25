import { describe, expect, test } from "bun:test";
import {
  canUnmask,
  maskRecord,
  maskRecords,
  maskValue,
  resolveFieldMasking,
} from "../src/security/masking-engine";
import type { Actor } from "../src/types/action";
import type { PermissionGroupDefinition } from "../src/types/permission";
import type { FieldDefinition, SchemaDefinition } from "../src/types/schema";

// ── maskValue tests ──────────────────────────────────────

describe("maskValue", () => {
  test("full strategy returns null", () => {
    expect(maskValue("secret-data", "full")).toBeNull();
    expect(maskValue(12345, "full")).toBeNull();
    expect(maskValue({ key: "val" }, "full")).toBeNull();
  });

  test("full strategy returns null for null/undefined input", () => {
    expect(maskValue(null, "full")).toBeNull();
    expect(maskValue(undefined, "full")).toBeNull();
  });

  test("redact strategy returns placeholder", () => {
    expect(maskValue("secret-data", "redact")).toBe("***");
    expect(maskValue(12345, "redact")).toBe("***");
  });

  test("redact returns null for null/undefined", () => {
    expect(maskValue(null, "redact")).toBeNull();
    expect(maskValue(undefined, "redact")).toBeNull();
  });

  test("hash strategy returns SHA-256 hex", () => {
    const result = maskValue("hello", "hash");
    expect(result).toBeTypeOf("string");
    expect(result!.length).toBe(64); // SHA-256 hex length
    // Deterministic
    expect(maskValue("hello", "hash")).toBe(result);
    // Different input → different hash
    expect(maskValue("world", "hash")).not.toBe(result);
  });

  test("hash strategy handles non-string values", () => {
    const result = maskValue(12345, "hash");
    expect(result).toBeTypeOf("string");
    expect(result!.length).toBe(64);
  });

  test("partial strategy masks with end position (default)", () => {
    expect(maskValue("1234567890", "partial")).toBe("******7890");
    expect(maskValue("1234567890", "partial", { visibleChars: 4 })).toBe("******7890");
  });

  test("partial strategy masks with start position", () => {
    expect(maskValue("1234567890", "partial", { visibleChars: 4, position: "start" })).toBe(
      "1234******",
    );
  });

  test("partial strategy with custom visibleChars", () => {
    expect(maskValue("1234567890", "partial", { visibleChars: 2 })).toBe("********90");
    expect(maskValue("1234567890", "partial", { visibleChars: 2, position: "start" })).toBe(
      "12********",
    );
  });

  test("partial strategy masks entirely when string is too short", () => {
    expect(maskValue("abc", "partial", { visibleChars: 4 })).toBe("***");
    expect(maskValue("ab", "partial", { visibleChars: 4 })).toBe("**");
  });

  test("partial strategy converts non-string to string", () => {
    expect(maskValue(12345, "partial", { visibleChars: 3 })).toBe("**345");
  });
});

// ── resolveFieldMasking tests ────────────────────────────

describe("resolveFieldMasking", () => {
  test("returns explicit masking config when set", () => {
    const field: FieldDefinition = {
      type: "string",
      sensitive: true,
      masking: { strategy: "hash" },
    };
    expect(resolveFieldMasking(field)).toEqual({ strategy: "hash" });
  });

  test("returns partial mask for sensitive fields without explicit masking", () => {
    const field: FieldDefinition = { type: "string", sensitive: true };
    const config = resolveFieldMasking(field);
    expect(config).toEqual({ strategy: "partial", visibleChars: 4, position: "end" });
  });

  test("returns full mask for secret fields without explicit masking", () => {
    const field: FieldDefinition = { type: "string", secret: true };
    expect(resolveFieldMasking(field)).toEqual({ strategy: "full" });
  });

  test("explicit masking takes priority over secret flag", () => {
    const field: FieldDefinition = {
      type: "string",
      secret: true,
      masking: { strategy: "redact" },
    };
    expect(resolveFieldMasking(field)).toEqual({ strategy: "redact" });
  });

  test("returns undefined for regular fields", () => {
    const field: FieldDefinition = { type: "string" };
    expect(resolveFieldMasking(field)).toBeUndefined();
  });
});

// ── canUnmask tests ──────────────────────────────────────

describe("canUnmask", () => {
  const adminGroup: PermissionGroupDefinition = {
    name: "system_admin",
    label: "System Admin",
    permissions: {},
  };

  const viewerGroup: PermissionGroupDefinition = {
    name: "viewer",
    label: "Viewer",
    permissions: {
      purchase: {
        order: {
          fields: { unmask: ["phone"] },
        },
      },
    },
  };

  const basicGroup: PermissionGroupDefinition = {
    name: "basic",
    label: "Basic",
    permissions: {
      purchase: {
        order: {
          fields: { visible: ["name"] },
        },
      },
    },
  };

  test("system_admin always has unmask permission", () => {
    const actor: Actor = { type: "human", id: "1", groups: ["system_admin"] };
    expect(canUnmask(actor, [adminGroup], "purchase", "order", "phone")).toBe(true);
  });

  test("system_admin must be registered in groups to take effect", () => {
    const actor: Actor = { type: "human", id: "1", groups: ["system_admin"] };
    // system_admin not in provided groups list
    expect(canUnmask(actor, [viewerGroup], "purchase", "order", "phone")).toBe(false);
  });

  test("actor with unmask permission for specific field", () => {
    const actor: Actor = { type: "human", id: "2", groups: ["viewer"] };
    expect(canUnmask(actor, [viewerGroup], "purchase", "order", "phone")).toBe(true);
  });

  test("actor without unmask permission for field", () => {
    const actor: Actor = { type: "human", id: "3", groups: ["basic"] };
    expect(canUnmask(actor, [basicGroup], "purchase", "order", "phone")).toBe(false);
  });

  test("actor without matching capability", () => {
    const actor: Actor = { type: "human", id: "2", groups: ["viewer"] };
    expect(canUnmask(actor, [viewerGroup], "other_cap", "order", "phone")).toBe(false);
  });
});

// ── maskRecord tests ─────────────────────────────────────

describe("maskRecord", () => {
  const schema: SchemaDefinition = {
    name: "customer",
    fields: {
      name: { type: "string" },
      email: { type: "string", sensitive: true },
      ssn: { type: "string", secret: true },
      phone: {
        type: "string",
        masking: { strategy: "partial", visibleChars: 4, position: "end" },
      },
      api_key: { type: "string", masking: { strategy: "hash" } },
      notes: { type: "text", masking: { strategy: "redact" } },
    },
  };

  const record = {
    id: "rec-1",
    name: "Alice",
    email: "alice@example.com",
    ssn: "123-45-6789",
    phone: "555-123-4567",
    api_key: "sk_live_abc123",
    notes: "Internal note about Alice",
  };

  test("masks all configured fields without actor context", () => {
    const masked = maskRecord(record, schema);

    // Non-masked fields unchanged
    expect(masked.id).toBe("rec-1");
    expect(masked.name).toBe("Alice");

    // sensitive → partial (default: last 4 chars)
    // "alice@example.com" = 17 chars, last 4 visible = ".com", 13 masked
    expect(masked.email).toBe("*************.com");

    // secret → full (null)
    expect(masked.ssn).toBeNull();

    // explicit partial
    expect(masked.phone).toBe("********4567");

    // explicit hash
    expect(masked.api_key).toBeTypeOf("string");
    expect((masked.api_key as string).length).toBe(64);

    // explicit redact
    expect(masked.notes).toBe("***");
  });

  test("does not mutate original record", () => {
    const original = { ...record };
    maskRecord(record, schema);
    expect(record).toEqual(original);
  });

  test("respects unmask permission for actor", () => {
    const actor: Actor = { type: "human", id: "1", groups: ["hr_manager"] };
    const groups: PermissionGroupDefinition[] = [
      {
        name: "hr_manager",
        label: "HR Manager",
        permissions: {
          crm: {
            customer: {
              fields: { unmask: ["email", "ssn"] },
            },
          },
        },
      },
    ];

    const masked = maskRecord(record, schema, {
      actor,
      groups,
      capabilityName: "crm",
    });

    // Unmasked fields — actor has unmask permission
    expect(masked.email).toBe("alice@example.com");
    expect(masked.ssn).toBe("123-45-6789");

    // Still masked — no unmask permission for these
    expect(masked.phone).toBe("********4567");
    expect(masked.notes).toBe("***");
  });

  test("system_admin sees all raw values", () => {
    const actor: Actor = { type: "human", id: "1", groups: ["system_admin"] };
    const groups: PermissionGroupDefinition[] = [
      { name: "system_admin", label: "Admin", permissions: {} },
    ];

    const masked = maskRecord(record, schema, {
      actor,
      groups,
      capabilityName: "crm",
    });

    expect(masked.email).toBe("alice@example.com");
    expect(masked.ssn).toBe("123-45-6789");
    expect(masked.phone).toBe("555-123-4567");
    expect(masked.api_key).toBe("sk_live_abc123");
    expect(masked.notes).toBe("Internal note about Alice");
  });

  test("handles records with missing masked fields gracefully", () => {
    const partial = { id: "rec-2", name: "Bob" };
    const masked = maskRecord(partial, schema);
    expect(masked.id).toBe("rec-2");
    expect(masked.name).toBe("Bob");
    // Missing fields should not appear
    expect("email" in masked).toBe(false);
    expect("ssn" in masked).toBe(false);
  });
});

// ── maskRecords tests ────────────────────────────────────

describe("maskRecords", () => {
  const schema: SchemaDefinition = {
    name: "user",
    fields: {
      name: { type: "string" },
      token: { type: "string", secret: true },
    },
  };

  test("masks all records in array", () => {
    const records = [
      { name: "Alice", token: "tok_a" },
      { name: "Bob", token: "tok_b" },
    ];

    const masked = maskRecords(records, schema);
    expect(masked).toHaveLength(2);
    expect(masked[0].name).toBe("Alice");
    expect(masked[0].token).toBeNull();
    expect(masked[1].name).toBe("Bob");
    expect(masked[1].token).toBeNull();
  });

  test("returns empty array for empty input", () => {
    expect(maskRecords([], schema)).toEqual([]);
  });
});
