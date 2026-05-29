/**
 * Tests for the pure AI-trace redaction + sampling helpers (Spec 69 Phase 3).
 */

import { describe, expect, it } from "bun:test";
import {
  type AITraceMessage,
  defaultRedactionFor,
  EVAL_REDACTION,
  PRODUCTION_REDACTION,
  type RedactionPolicy,
  redactContent,
  redactPromptMessages,
  shouldSample,
} from "../ai-trace";

const messages: AITraceMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "my secret password is hunter2" },
];

describe("redactContent", () => {
  it("none mode returns content verbatim", () => {
    expect(redactContent("hello world", { mode: "none" })).toBe("hello world");
  });

  it("drop mode returns empty string", () => {
    expect(redactContent("hello world", { mode: "drop" })).toBe("");
  });

  it("hash mode returns a stable sha256 hex digest", () => {
    const a = redactContent("hello world", { mode: "hash" });
    const b = redactContent("hello world", { mode: "hash" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("hello");
  });

  it("hash mode differs for different content", () => {
    const a = redactContent("alpha", { mode: "hash" });
    const b = redactContent("beta", { mode: "hash" });
    expect(a).not.toBe(b);
  });

  it("mask mode keeps only trailing visible chars", () => {
    const masked = redactContent("supersecret", { mode: "mask", visibleChars: 4 });
    // "supersecret" → 7 stars + "cret"
    expect(masked).toBe("*******cret");
    expect(masked).not.toContain("super");
  });

  it("mask mode defaults to 4 visible chars", () => {
    const masked = redactContent("abcdefgh", { mode: "mask" });
    expect(masked.endsWith("efgh")).toBe(true);
    expect(masked.slice(0, 4)).toBe("****");
  });

  it("mask mode on empty string returns empty (no placeholder)", () => {
    expect(redactContent("", { mode: "mask" })).toBe("");
  });
});

describe("redactPromptMessages", () => {
  it("none mode preserves roles and content", () => {
    const out = redactPromptMessages(messages, { mode: "none" });
    expect(out).toEqual(messages);
    // Returns a new array (no mutation).
    expect(out).not.toBe(messages);
  });

  it("drop mode empties every content but keeps roles", () => {
    const out = redactPromptMessages(messages, { mode: "drop" });
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out.every((m) => m.content === "")).toBe(true);
  });

  it("hash mode hashes every message content", () => {
    const out = redactPromptMessages(messages, { mode: "hash" });
    for (const m of out) {
      expect(m.content).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(out[1]?.content).not.toContain("hunter2");
  });

  it("mask mode masks the leading portion of each content", () => {
    const out = redactPromptMessages(messages, { mode: "mask", visibleChars: 4 });
    expect(out[1]?.content).not.toContain("password");
    expect(out[1]?.content.endsWith("er2")).toBe(true);
  });

  it("does not mutate the input messages", () => {
    const original = [...messages.map((m) => ({ ...m }))];
    redactPromptMessages(messages, { mode: "hash" });
    expect(messages).toEqual(original);
  });
});

describe("defaultRedactionFor", () => {
  it("production origin masks", () => {
    expect(defaultRedactionFor("production")).toBe(PRODUCTION_REDACTION);
    expect(PRODUCTION_REDACTION.mode).toBe("mask");
  });

  it("eval origin keeps verbatim", () => {
    expect(defaultRedactionFor("eval")).toBe(EVAL_REDACTION);
    expect(EVAL_REDACTION.mode).toBe("none");
  });

  it("undefined origin defaults to production (mask)", () => {
    expect(defaultRedactionFor(undefined)).toBe(PRODUCTION_REDACTION);
  });
});

describe("shouldSample", () => {
  it("rate 1 always records", () => {
    expect(shouldSample({ rate: 1 }, () => 0.99)).toBe(true);
  });

  it("rate 0 never records", () => {
    expect(shouldSample({ rate: 0 }, () => 0)).toBe(false);
  });

  it("undefined config records everything", () => {
    expect(shouldSample(undefined, () => 0.99)).toBe(true);
  });

  it("rate 0.5 records when rng below rate", () => {
    expect(shouldSample({ rate: 0.5 }, () => 0.4)).toBe(true);
    expect(shouldSample({ rate: 0.5 }, () => 0.6)).toBe(false);
  });

  it("frozen default policies are immutable", () => {
    const policy: RedactionPolicy = PRODUCTION_REDACTION;
    expect(Object.isFrozen(policy)).toBe(true);
  });
});
