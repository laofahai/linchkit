/**
 * Tests for cap-lock capability wiring (Spec 63 §4.2, §9).
 *
 * Asserts metadata + that the capability exposes `extensions.interceptors`
 * with exactly one entry at point "field-lock-check" whose handler behaves
 * per the policy (allow on shadow, block otherwise — fail-closed).
 */

import { describe, expect, it } from "bun:test";
import type { FieldLockCheckContext, FieldLockViolation, Logger } from "@linchkit/core";
import { capLock } from "../src/capability";
import { createCapLock } from "../src/factory";

function makeContext(): FieldLockCheckContext {
  return {
    entity: "purchase_request",
    actor: { type: "human", id: "user-1", groups: ["admin"] },
    record: { status: "submitted", created_at: new Date("2026-01-01T00:00:00Z") },
    input: { amount: 200 },
    tenantId: "t1",
  };
}

function makeViolations(): FieldLockViolation[] {
  return [{ field: "amount", type: "locked", message: 'Field "amount" is locked' }];
}

describe("cap-lock capability metadata", () => {
  it("has the expected metadata", () => {
    expect(capLock.name).toBe("cap-lock");
    expect(capLock.type).toBe("standard");
    expect(capLock.category).toBe("system");
    expect(capLock.version).toBe("0.0.1");
    expect(capLock.coreVersion).toBe("^0.2.0");
  });

  it("declares only the database.read system permission", () => {
    expect(capLock.systemPermissions).toEqual(["database.read"]);
  });

  it("exposes a config schema", () => {
    expect(capLock.configSchema).toBeDefined();
  });
});

describe("cap-lock interceptor registration", () => {
  it("exposes exactly one field-lock-check interceptor", () => {
    const interceptors = capLock.extensions?.interceptors;
    expect(interceptors).toBeDefined();
    expect(interceptors).toHaveLength(1);
    const reg = interceptors?.[0];
    expect(reg?.point).toBe("field-lock-check");
    expect(reg?.capability).toBe("lock");
    expect(typeof reg?.handler).toBe("function");
  });

  it("default-config handler blocks (returns violations unchanged)", async () => {
    const reg = capLock.extensions?.interceptors?.[0];
    if (!reg) throw new Error("expected an interceptor registration");
    const violations = makeViolations();

    const result = await reg.handler(violations, makeContext());

    expect(result).toBe(violations);
  });

  it("registered handler honors shadow-mode config and logs via injected logger", async () => {
    const calls: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => {},
      info: (message, context) => calls.push({ message, context }),
      warn: () => {},
      error: () => {},
    };
    const cap = createCapLock({ config: { shadowMode: true }, logger });
    const reg = cap.extensions?.interceptors?.[0];
    if (!reg) throw new Error("expected an interceptor registration");

    const result = await reg.handler(makeViolations(), makeContext());

    expect(result).toEqual([]);
    expect(calls.find((c) => c.context?.reason === "shadow")).toBeDefined();
  });

  it("registered handler honors bypass-group config", async () => {
    const cap = createCapLock({ config: { bypassGroups: ["admin"] } });
    const reg = cap.extensions?.interceptors?.[0];
    if (!reg) throw new Error("expected an interceptor registration");

    const result = await reg.handler(makeViolations(), makeContext());

    expect(result).toEqual([]);
  });

  it("uses the injected clock for tolerance", async () => {
    const cap = createCapLock({
      config: { toleranceMs: 5 * 60 * 1000 },
      now: () => Date.parse("2026-01-01T00:01:00Z"),
    });
    const reg = cap.extensions?.interceptors?.[0];
    if (!reg) throw new Error("expected an interceptor registration");

    const result = await reg.handler(makeViolations(), makeContext());

    expect(result).toEqual([]);
  });
});
