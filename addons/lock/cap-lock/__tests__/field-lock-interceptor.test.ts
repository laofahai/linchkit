/**
 * Tests for the cap-lock `field-lock-check` interceptor (Spec 63 §4.2, §9).
 *
 * Covers: shadow on/off, bypass group hit/miss, tolerance within/after window,
 * toleranceMs=0, missing/unparseable created_at (fail-closed), the no-condition
 * default (returns the SAME violations), and the audit-log shape. Time is
 * injected via `now`; logging is captured by a fake logger spy.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Actor, FieldLockCheckContext, FieldLockViolation, Logger } from "@linchkit/core";
import { resolveCapLockPolicy } from "../src/config";
import type { LockOverrideEvent } from "../src/events";
import {
  createFieldLockInterceptor,
  type FieldLockInterceptorOptions,
} from "../src/field-lock-interceptor";

// ── Test fixtures ─────────────────────────────────────────

interface LoggedCall {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

/** A fake logger that records every call for assertions. */
function createFakeLogger(): Logger & { calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  return {
    calls,
    debug: (message, context) => calls.push({ level: "debug", message, context }),
    info: (message, context) => calls.push({ level: "info", message, context }),
    warn: (message, context) => calls.push({ level: "warn", message, context }),
    error: (message, context) => calls.push({ level: "error", message, context }),
  };
}

function makeActor(groups: string[] = []): Actor {
  return { type: "human", id: "user-1", groups };
}

function makeViolations(): FieldLockViolation[] {
  return [
    {
      field: "amount",
      type: "locked",
      mode: "hard",
      message: 'Field "amount" is locked in state "submitted"',
    },
    {
      field: "code",
      type: "immutable",
      mode: "hard",
      message: 'Field "code" is immutable and cannot be modified',
    },
  ];
}

/** A single soft (advisory) conditional-lock violation. */
function softViolation(field = "amount"): FieldLockViolation {
  return { field, type: "locked", mode: "soft", message: `Field "${field}" is locked` };
}

/** A single hard conditional-lock violation. */
function hardViolation(field = "supplier"): FieldLockViolation {
  return { field, type: "locked", mode: "hard", message: `Field "${field}" is locked` };
}

function makeContext(overrides?: Partial<FieldLockCheckContext>): FieldLockCheckContext {
  return {
    entity: "purchase_request",
    actor: makeActor(),
    record: { id: "r1", status: "submitted", created_at: new Date("2026-01-01T00:00:00Z") },
    input: { amount: 200 },
    tenantId: "t1",
    ...overrides,
  };
}

/** Build a handler with a fixed `now` and fake logger for determinism. */
function buildHandler(
  partial: Partial<FieldLockInterceptorOptions> & {
    config?: Parameters<typeof resolveCapLockPolicy>[0];
  },
) {
  const logger = createFakeLogger();
  const handler = createFieldLockInterceptor({
    policy: resolveCapLockPolicy(partial.config),
    logger,
    now: partial.now ?? (() => Date.parse("2026-01-01T00:01:00Z")),
  });
  return { handler, logger };
}

// ── Tests ─────────────────────────────────────────────────

describe("cap-lock field-lock-check interceptor", () => {
  let violations: FieldLockViolation[];

  beforeEach(() => {
    violations = makeViolations();
  });

  describe("shadow mode", () => {
    it("shadow on → all violations suppressed and audit-logged", async () => {
      const { handler, logger } = buildHandler({ config: { shadowMode: true } });

      const result = await handler(violations, makeContext());

      expect(result).toEqual([]);
      const log = logger.calls.find((c) => c.context?.reason === "shadow");
      expect(log).toBeDefined();
      expect(log?.level).toBe("info");
    });

    it("shadow off (default) → pass-through (returns the same violations)", async () => {
      const { handler, logger } = buildHandler({ config: {} });

      const result = await handler(violations, makeContext());

      expect(result).toBe(violations); // unchanged reference
      expect(result).toEqual(makeViolations());
      expect(logger.calls).toHaveLength(0);
    });
  });

  describe("bypass groups", () => {
    it("actor in a bypass group → suppressed and audit-logged", async () => {
      const { handler, logger } = buildHandler({ config: { bypassGroups: ["admin"] } });
      const ctx = makeContext({ actor: makeActor(["staff", "admin"]) });

      const result = await handler(violations, ctx);

      expect(result).toEqual([]);
      const log = logger.calls.find((c) => c.context?.reason === "bypass");
      expect(log).toBeDefined();
    });

    it("actor NOT in any bypass group → violations returned UNCHANGED", async () => {
      const { handler, logger } = buildHandler({ config: { bypassGroups: ["admin"] } });
      const ctx = makeContext({ actor: makeActor(["staff"]) });

      const result = await handler(violations, ctx);

      expect(result).toBe(violations);
      expect(logger.calls).toHaveLength(0);
    });

    it("empty bypassGroups never suppresses even for empty actor groups", async () => {
      const { handler } = buildHandler({ config: { bypassGroups: [] } });
      const ctx = makeContext({ actor: makeActor([]) });

      const result = await handler(violations, ctx);

      expect(result).toBe(violations);
    });
  });

  describe("tolerance period", () => {
    const created = "2026-01-01T00:00:00Z";

    it("within window → suppressed and audit-logged", async () => {
      // age = 60s; window = 5min → within.
      const { handler, logger } = buildHandler({
        config: { toleranceMs: 5 * 60 * 1000 },
        now: () => Date.parse("2026-01-01T00:01:00Z"),
      });
      const ctx = makeContext({ record: { status: "submitted", created_at: created } });

      const result = await handler(violations, ctx);

      expect(result).toEqual([]);
      expect(logger.calls.find((c) => c.context?.reason === "tolerance")).toBeDefined();
    });

    it("after window → violations returned UNCHANGED", async () => {
      // age = 10min; window = 5min → expired.
      const { handler, logger } = buildHandler({
        config: { toleranceMs: 5 * 60 * 1000 },
        now: () => Date.parse("2026-01-01T00:10:00Z"),
      });
      const ctx = makeContext({ record: { status: "submitted", created_at: created } });

      const result = await handler(violations, ctx);

      expect(result).toBe(violations);
      expect(logger.calls).toHaveLength(0);
    });

    it("toleranceMs=0 (default) → never suppresses on age", async () => {
      const { handler } = buildHandler({
        config: { toleranceMs: 0 },
        now: () => Date.parse("2026-01-01T00:00:00Z"), // age 0
      });
      const ctx = makeContext({ record: { status: "submitted", created_at: created } });

      const result = await handler(violations, ctx);

      expect(result).toBe(violations);
    });

    it("accepts Date, ISO string, and epoch-number created_at", async () => {
      const now = () => Date.parse("2026-01-01T00:01:00Z");
      const epoch = Date.parse(created);
      for (const createdAt of [new Date(created), created, epoch]) {
        const { handler } = buildHandler({ config: { toleranceMs: 5 * 60 * 1000 }, now });
        const ctx = makeContext({ record: { status: "submitted", created_at: createdAt } });
        const result = await handler(makeViolations(), ctx);
        expect(result).toEqual([]);
      }
    });

    it("missing created_at → NOT suppressed (fail-closed)", async () => {
      const { handler } = buildHandler({
        config: { toleranceMs: 5 * 60 * 1000 },
        now: () => Date.parse("2026-01-01T00:01:00Z"),
      });
      const ctx = makeContext({ record: { status: "submitted" } });

      const result = await handler(violations, ctx);

      expect(result).toBe(violations);
    });

    it("unparseable created_at → NOT suppressed (fail-closed)", async () => {
      const { handler } = buildHandler({
        config: { toleranceMs: 5 * 60 * 1000 },
        now: () => Date.parse("2026-01-01T00:01:00Z"),
      });
      const ctx = makeContext({ record: { status: "submitted", created_at: "not-a-date" } });

      const result = await handler(violations, ctx);

      expect(result).toBe(violations);
    });
  });

  describe("fail-closed default", () => {
    it("no condition matches → returns the SAME violations", async () => {
      const { handler, logger } = buildHandler({
        config: { shadowMode: false, bypassGroups: ["admin"], toleranceMs: 1000 },
        now: () => Date.parse("2026-01-01T01:00:00Z"), // long after creation
      });
      const ctx = makeContext({ actor: makeActor(["staff"]) });

      const result = await handler(violations, ctx);

      expect(result).toBe(violations);
      expect(result).toEqual(makeViolations());
      expect(logger.calls).toHaveLength(0);
    });

    it("empty violation set is returned unchanged and never logged", async () => {
      const { handler, logger } = buildHandler({ config: { shadowMode: true } });

      const result = await handler([], makeContext());

      expect(result).toEqual([]);
      expect(logger.calls).toHaveLength(0);
    });

    it("does not mutate its violations argument when suppressing", async () => {
      const { handler } = buildHandler({ config: { shadowMode: true } });
      const input = makeViolations();
      const snapshot = JSON.stringify(input);

      await handler(input, makeContext());

      expect(JSON.stringify(input)).toBe(snapshot);
    });
  });

  describe("audit logger shape (Spec 63 §4.2)", () => {
    it("logs the documented structured context", async () => {
      const { handler, logger } = buildHandler({ config: { shadowMode: true } });
      const ctx = makeContext({ actor: makeActor(["staff"]) });

      await handler(violations, ctx);

      const log = logger.calls.find((c) => c.context?.reason === "shadow");
      expect(log).toBeDefined();
      expect(log?.context).toMatchObject({
        capability: "lock",
        reason: "shadow",
        entity: "purchase_request",
        actorId: "user-1",
        tenantId: "t1",
        fields: ["amount", "code"],
      });
    });

    it("suppression is silent when no logger is injected", async () => {
      const handler = createFieldLockInterceptor({
        policy: resolveCapLockPolicy({ shadowMode: true }),
        now: () => 0,
      });

      // Must not throw despite no logger.
      const result = await handler(makeViolations(), makeContext());
      expect(result).toEqual([]);
    });
  });

  // ── Soft locks (Spec 63 §4.2 SOFT_LOCK) ───────────────────────────
  describe("soft locks", () => {
    it("soft-only violation → suppressed (advisory allow) and audited as 'soft'", async () => {
      const { handler, logger } = buildHandler({ config: {} });
      const ctx = makeContext({ actor: makeActor([]) });

      const result = await handler([softViolation("amount")], ctx);

      expect(result).toEqual([]);
      const log = logger.calls.find((c) => c.context?.reason === "soft");
      expect(log).toBeDefined();
      expect(log?.level).toBe("info");
      expect(log?.context).toMatchObject({
        capability: "lock",
        reason: "soft",
        fields: ["amount"],
      });
    });

    it("mixed soft + hard → only hard returned, soft subset audited", async () => {
      const { handler, logger } = buildHandler({ config: {} });
      const ctx = makeContext({ actor: makeActor([]) });
      const input = [softViolation("amount"), hardViolation("supplier")];

      const result = await handler(input, ctx);

      // Hard violation still blocks; soft is dropped.
      expect(result).toEqual([hardViolation("supplier")]);
      const log = logger.calls.find((c) => c.context?.reason === "soft");
      expect(log).toBeDefined();
      // Only the soft field is reported in the soft audit entry.
      expect(log?.context).toMatchObject({ fields: ["amount"], violationCount: 1 });
    });

    it("soft is NOT actor-gated → any actor proceeds without a bypass group", async () => {
      const { handler } = buildHandler({ config: { bypassGroups: ["admin"] } });
      // Actor has no groups, so an actor-level bypass would NOT apply — yet a
      // soft lock is still allowed-with-audit (the UI confirmation is the gate).
      const ctx = makeContext({ actor: makeActor(["staff"]) });

      const result = await handler([softViolation("amount")], ctx);

      expect(result).toEqual([]);
    });

    it("soft + shadowMode → all suppressed, audited as 'shadow' (shadow wins, no 'soft' log)", async () => {
      const { handler, logger } = buildHandler({ config: { shadowMode: true } });
      const ctx = makeContext({ actor: makeActor([]) });

      const result = await handler([softViolation("amount"), hardViolation("supplier")], ctx);

      expect(result).toEqual([]);
      expect(logger.calls.find((c) => c.context?.reason === "shadow")).toBeDefined();
      // Shadow short-circuits before the soft partition — no separate soft log.
      expect(logger.calls.find((c) => c.context?.reason === "soft")).toBeUndefined();
    });

    it("soft + bypass group → all suppressed, audited as 'bypass' (bypass wins, no 'soft' log)", async () => {
      const { handler, logger } = buildHandler({ config: { bypassGroups: ["admin"] } });
      const ctx = makeContext({ actor: makeActor(["admin"]) });

      const result = await handler([softViolation("amount"), hardViolation("supplier")], ctx);

      expect(result).toEqual([]);
      expect(logger.calls.find((c) => c.context?.reason === "bypass")).toBeDefined();
      expect(logger.calls.find((c) => c.context?.reason === "soft")).toBeUndefined();
    });
  });

  // ── Override notification event (Spec 63 §4.2 Notification) ────────
  describe("lock.override event emission", () => {
    /** Build a handler with an event-capture sink (1:1 with the audit log). */
    function buildEventHandler(
      partial: Partial<FieldLockInterceptorOptions> & {
        config?: Parameters<typeof resolveCapLockPolicy>[0];
      },
    ) {
      const events: LockOverrideEvent[] = [];
      const handler = createFieldLockInterceptor({
        policy: resolveCapLockPolicy(partial.config),
        now: partial.now ?? (() => Date.parse("2026-01-01T00:01:00Z")),
        emitEvent: (e) => events.push(e),
      });
      return { handler, events };
    }

    it("bypass → emits one event with reason 'bypass' and the suppressed fields", async () => {
      const { handler, events } = buildEventHandler({ config: { bypassGroups: ["admin"] } });
      const ctx = makeContext({ actor: makeActor(["staff", "admin"]) });

      await handler(makeViolations(), ctx);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "lock.override",
        reason: "bypass",
        entity: "purchase_request",
        recordId: "r1",
        actorId: "user-1",
        actorType: "human",
        tenantId: "t1",
        fields: ["amount", "code"],
      });
    });

    it("shadow → emits one event with reason 'shadow' and all violation fields", async () => {
      const { handler, events } = buildEventHandler({ config: { shadowMode: true } });

      await handler(makeViolations(), makeContext());

      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe("shadow");
      expect(events[0]?.fields).toEqual(["amount", "code"]);
    });

    it("tolerance → emits one event with reason 'tolerance'", async () => {
      const { handler, events } = buildEventHandler({
        config: { toleranceMs: 5 * 60 * 1000 },
        now: () => Date.parse("2026-01-01T00:01:00Z"),
      });
      const ctx = makeContext({
        record: { id: "r1", status: "submitted", created_at: "2026-01-01T00:00:00Z" },
      });

      await handler(makeViolations(), ctx);

      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe("tolerance");
    });

    it("soft (mixed) → emits one event with reason 'soft' and ONLY the soft fields", async () => {
      const { handler, events } = buildEventHandler({ config: {} });
      const ctx = makeContext({ actor: makeActor([]) });

      const result = await handler([softViolation("amount"), hardViolation("supplier")], ctx);

      // Hard violation still blocks; soft is dropped.
      expect(result).toEqual([hardViolation("supplier")]);
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe("soft");
      // Mirrors `audit("soft", soft)` — only the soft subset's fields.
      expect(events[0]?.fields).toEqual(["amount"]);
    });

    it("fail-closed default (no knob, no soft) → no event AND original violations by reference", async () => {
      const { handler, events } = buildEventHandler({
        config: { shadowMode: false, bypassGroups: ["admin"], toleranceMs: 1000 },
        now: () => Date.parse("2026-01-01T01:00:00Z"),
      });
      const ctx = makeContext({ actor: makeActor(["staff"]) });
      const input = makeViolations();

      const result = await handler(input, ctx);

      expect(events).toHaveLength(0);
      expect(result).toBe(input); // unchanged reference (fail-closed)
    });

    it("empty violation set → no event emitted", async () => {
      const { handler, events } = buildEventHandler({ config: { shadowMode: true } });

      await handler([], makeContext());

      expect(events).toHaveLength(0);
    });

    it("no emitEvent injected → byte-identical suppression behavior, no throw", async () => {
      const logger = createFakeLogger();
      const handler = createFieldLockInterceptor({
        policy: resolveCapLockPolicy({ shadowMode: true }),
        logger,
        now: () => Date.parse("2026-01-01T00:01:00Z"),
      });

      const result = await handler(makeViolations(), makeContext());

      expect(result).toEqual([]);
      expect(logger.calls.find((c) => c.context?.reason === "shadow")).toBeDefined();
    });

    it("sink throws → suppression result is still returned (error does not propagate)", async () => {
      const logger = createFakeLogger();
      const handler = createFieldLockInterceptor({
        policy: resolveCapLockPolicy({ shadowMode: true }),
        logger,
        now: () => Date.parse("2026-01-01T00:01:00Z"),
        emitEvent: () => {
          throw new Error("boom");
        },
      });

      const result = await handler(makeViolations(), makeContext());

      // Allowed write must NOT be turned into a throw; result is the suppression.
      expect(result).toEqual([]);
      // The faulty sink is noted at warn level.
      expect(logger.calls.find((c) => c.level === "warn")).toBeDefined();
    });

    it("recordId: string id surfaces; non-string/absent id is omitted", async () => {
      // String id → surfaced.
      const withId = buildEventHandler({ config: { shadowMode: true } });
      await withId.handler(
        makeViolations(),
        makeContext({ record: { id: "rec-42", status: "submitted" } }),
      );
      expect(withId.events[0]?.recordId).toBe("rec-42");

      // No id on the record → omitted (undefined).
      const noId = buildEventHandler({ config: { shadowMode: true } });
      await noId.handler(makeViolations(), makeContext({ record: { status: "submitted" } }));
      expect(noId.events[0]?.recordId).toBeUndefined();

      // Non-string id (number) → omitted (undefined), no coercion.
      const numId = buildEventHandler({ config: { shadowMode: true } });
      await numId.handler(
        makeViolations(),
        makeContext({ record: { id: 7, status: "submitted" } }),
      );
      expect(numId.events[0]?.recordId).toBeUndefined();
    });
  });
});
