import { describe, expect, test } from "bun:test";
import { MaskingSession, maskContext, maskRecord, unmaskContext } from "../src/ai/context-masker";

// ── MaskingSession ──────────────────────────────────────

describe("MaskingSession", () => {
  test("masks and unmasks a single value", () => {
    const session = new MaskingSession();
    const token = session.mask("hello@example.com", "EMAIL");

    expect(token).toContain("MASKED");
    expect(token).toContain("EMAIL");
    expect(token).not.toContain("hello@example.com");

    const unmasked = session.unmask(`Contact: ${token}`);
    expect(unmasked).toBe("Contact: hello@example.com");
  });

  test("deduplicates identical values", () => {
    const session = new MaskingSession();
    const token1 = session.mask("test@test.com", "EMAIL");
    const token2 = session.mask("test@test.com", "EMAIL");

    expect(token1).toBe(token2);
    expect(session.size).toBe(1);
  });

  test("uses custom prefix", () => {
    const session = new MaskingSession("HIDDEN");
    const token = session.mask("secret", "DATA");

    expect(token).toContain("HIDDEN");
    expect(token).not.toContain("MASKED");
  });

  test("tracks token count", () => {
    const session = new MaskingSession();
    session.mask("a", "X");
    session.mask("b", "X");
    session.mask("a", "X"); // duplicate

    expect(session.size).toBe(2);
    expect(session.tokens).toHaveLength(2);
  });
});

// ── maskContext (string) ────────────────────────────────

describe("maskContext", () => {
  test("masks email addresses", () => {
    const result = maskContext("Contact john@example.com for info");

    expect(result.masked).not.toContain("john@example.com");
    expect(result.masked).toContain("[MASKED_EMAIL_");
    expect(result.maskCount).toBe(1);
  });

  test("masks phone numbers", () => {
    const result = maskContext("Call me at +1-234-567-8901");

    expect(result.masked).not.toContain("+1-234-567-8901");
    expect(result.maskCount).toBeGreaterThanOrEqual(1);
  });

  test("masks SSN patterns", () => {
    const result = maskContext("SSN: 123-45-6789");

    expect(result.masked).not.toContain("123-45-6789");
    expect(result.masked).toContain("[MASKED_SSN_");
    expect(result.maskCount).toBeGreaterThanOrEqual(1);
  });

  test("masks credit card numbers", () => {
    const result = maskContext("Card: 4111-1111-1111-1111");

    expect(result.masked).not.toContain("4111-1111-1111-1111");
    expect(result.maskCount).toBeGreaterThanOrEqual(1);
  });

  test("masks IP addresses", () => {
    const result = maskContext("Server at 192.168.1.100");

    expect(result.masked).not.toContain("192.168.1.100");
    expect(result.masked).toContain("[MASKED_IP_");
    expect(result.maskCount).toBe(1);
  });

  test("masks Chinese ID numbers", () => {
    const result = maskContext("ID: 110101199001011234");

    expect(result.masked).not.toContain("110101199001011234");
    expect(result.maskCount).toBeGreaterThanOrEqual(1);
  });

  test("masks multiple patterns in one string", () => {
    const input = "Email john@example.com, SSN 123-45-6789, IP 10.0.0.1";
    const result = maskContext(input);

    expect(result.masked).not.toContain("john@example.com");
    expect(result.masked).not.toContain("123-45-6789");
    expect(result.masked).not.toContain("10.0.0.1");
    expect(result.maskCount).toBeGreaterThanOrEqual(3);
  });

  test("preserves non-sensitive text", () => {
    const result = maskContext("Hello world, this is a normal sentence.");

    expect(result.masked).toBe("Hello world, this is a normal sentence.");
    expect(result.maskCount).toBe(0);
  });

  test("supports custom token prefix", () => {
    const result = maskContext("Email: test@test.com", { tokenPrefix: "REDACT" });

    expect(result.masked).toContain("[REDACT_EMAIL_");
  });

  test("supports custom rules", () => {
    const result = maskContext("Order #ORD-12345 confirmed", {
      useBuiltinRules: false,
      customRules: [
        {
          name: "order_id",
          pattern: /ORD-\d+/g,
          category: "ORDER",
        },
      ],
    });

    expect(result.masked).not.toContain("ORD-12345");
    expect(result.masked).toContain("[MASKED_ORDER_");
  });
});

// ── Round-trip mask/unmask ───────────────────────────────

describe("round-trip mask/unmask", () => {
  test("unmasks context after AI processing", () => {
    const original = "Contact john@example.com about order";
    const { masked, session } = maskContext(original);

    // Simulate AI response that references the masked token
    const aiResponse = `I will contact ${masked.match(/\[MASKED_EMAIL_\d+\]/)?.[0]} regarding the order.`;

    const unmasked = unmaskContext(aiResponse, session);
    expect(unmasked).toContain("john@example.com");
    expect(unmasked).not.toContain("MASKED_EMAIL");
  });

  test("unmasks multiple tokens in response", () => {
    const original = "User john@test.com from 192.168.1.1";
    const { masked, session } = maskContext(original);

    // AI echoes back the masked content
    const unmasked = unmaskContext(masked, session);
    expect(unmasked).toBe(original);
  });

  test("unmask leaves unknown tokens untouched", () => {
    const session = new MaskingSession();
    session.mask("real@email.com", "EMAIL");

    const text = "Found [MASKED_EMAIL_1] and [MASKED_OTHER_99]";
    const unmasked = session.unmask(text);

    expect(unmasked).toContain("real@email.com");
    expect(unmasked).toContain("[MASKED_OTHER_99]"); // unknown token preserved
  });
});

// ── maskRecord (object) ─────────────────────────────────

describe("maskRecord", () => {
  test("masks sensitive fields in a record", () => {
    const record = {
      name: "John Doe",
      email: "john@example.com",
      notes: "Call at 555-123-4567",
      age: 30,
    };

    const result = maskRecord(record);

    expect(result.masked.email).not.toContain("john@example.com");
    expect(result.masked.notes).not.toContain("555-123-4567");
    expect(result.masked.age).toBe(30); // non-string unchanged
    expect(result.maskCount).toBeGreaterThanOrEqual(2);
  });

  test("masks entire field with alwaysMaskFields", () => {
    const record = {
      name: "John Doe",
      secret_key: "sk_live_abc123",
    };

    const result = maskRecord(record, {
      alwaysMaskFields: ["secret_key"],
    });

    expect(result.masked.secret_key).not.toContain("sk_live_abc123");
    expect(String(result.masked.secret_key)).toContain("[MASKED_FIELD_");
  });

  test("masks non-string always-mask fields as JSON", () => {
    const record = {
      metadata: { key: "value" },
    };

    const result = maskRecord(record, {
      alwaysMaskFields: ["metadata"],
    });

    expect(String(result.masked.metadata)).toContain("[MASKED_FIELD_");
    const unmasked = result.session.unmask(String(result.masked.metadata));
    expect(unmasked).toBe(JSON.stringify({ key: "value" }));
  });

  test("preserves null and undefined in always-mask fields", () => {
    const record = {
      optional_field: null,
      missing_field: undefined,
    };

    const result = maskRecord(record, {
      alwaysMaskFields: ["optional_field", "missing_field"],
    });

    expect(result.masked.optional_field).toBeNull();
    expect(result.masked.missing_field).toBeUndefined();
  });

  test("round-trips record masking", () => {
    const record = {
      email: "alice@corp.com",
      bio: "Lives at 10.20.30.40",
    };

    const { masked, session } = maskRecord(record);

    // Unmask each string field
    const unmEmail = session.unmask(String(masked.email));
    const unmBio = session.unmask(String(masked.bio));

    expect(unmEmail).toBe("alice@corp.com");
    expect(unmBio).toBe("Lives at 10.20.30.40");
  });
});
