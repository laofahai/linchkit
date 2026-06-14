/**
 * Interrupt store unit tests (Spec 71 §6.7, P2a).
 *
 * The store is the load-bearing cross-connection state. P2a exercises the
 * `put`/`get` write path and the synchronous one-shot `claim` contract that
 * P2b's resume handler depends on.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryInterruptStore, type InterruptStoreEntry } from "../src/interrupt-store";

function entry(overrides: Partial<InterruptStoreEntry> = {}): InterruptStoreEntry {
  return {
    threadId: "t1",
    interruptId: "i1",
    toolCallId: "lk:propose-mutation:i1",
    actionSet: ["create_product"],
    proposedInput: { name: "Widget", price: 9.9 },
    inputDigest: "deadbeef",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    consumed: false,
    proposerActor: { type: "human", id: "user-1" },
    tenant: "tenant-a",
    ...overrides,
  };
}

describe("InMemoryInterruptStore", () => {
  test("put then get round-trips the entry (consumed:false)", () => {
    const store = new InMemoryInterruptStore();
    store.put(entry());
    const got = store.get("t1", "i1");
    expect(got).toBeDefined();
    expect(got?.consumed).toBe(false);
    expect(got?.actionSet).toEqual(["create_product"]);
    expect(got?.proposerActor).toEqual({ type: "human", id: "user-1" });
    expect(got?.tenant).toBe("tenant-a");
  });

  test("get returns undefined for an absent key", () => {
    const store = new InMemoryInterruptStore();
    expect(store.get("t1", "missing")).toBeUndefined();
  });

  test("get returns a copy — callers cannot mutate stored state out of band", () => {
    const store = new InMemoryInterruptStore();
    store.put(entry());
    const got = store.get("t1", "i1");
    expect(got).toBeDefined();
    if (got) got.consumed = true; // mutate the copy
    // The stored entry is untouched.
    expect(store.get("t1", "i1")?.consumed).toBe(false);
  });

  test("claim is one-shot — the second claim returns false (anti-double-execute)", () => {
    const store = new InMemoryInterruptStore();
    store.put(entry());
    // First claim wins.
    expect(store.claim("t1", "i1")).toBe(true);
    // Replay / concurrent second claim loses.
    expect(store.claim("t1", "i1")).toBe(false);
    // The flag is now durably consumed.
    expect(store.get("t1", "i1")?.consumed).toBe(true);
  });

  test("claim returns false for an absent entry (forgotten interrupt)", () => {
    const store = new InMemoryInterruptStore();
    expect(store.claim("t1", "missing")).toBe(false);
  });

  test("release restores a claimed entry so a legitimate retry is possible", () => {
    const store = new InMemoryInterruptStore();
    store.put(entry());
    expect(store.claim("t1", "i1")).toBe(true);
    store.release("t1", "i1");
    // After a released (transient) failure, the one shot is available again.
    expect(store.get("t1", "i1")?.consumed).toBe(false);
    expect(store.claim("t1", "i1")).toBe(true);
  });

  test("evict removes the entry entirely (consume / reject / expiry / abandon)", () => {
    const store = new InMemoryInterruptStore();
    store.put(entry());
    store.evict("t1", "i1");
    expect(store.get("t1", "i1")).toBeUndefined();
    // A resume against an evicted entry can never claim it.
    expect(store.claim("t1", "i1")).toBe(false);
  });

  test("entries are isolated per (threadId, interruptId)", () => {
    const store = new InMemoryInterruptStore();
    store.put(entry({ threadId: "t1", interruptId: "i1" }));
    store.put(entry({ threadId: "t2", interruptId: "i1" }));
    expect(store.claim("t1", "i1")).toBe(true);
    // Same interruptId on a different thread is a different record.
    expect(store.get("t2", "i1")?.consumed).toBe(false);
    expect(store.claim("t2", "i1")).toBe(true);
  });
});
