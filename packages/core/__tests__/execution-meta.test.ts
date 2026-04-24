/**
 * ExecutionMeta — unit tests (Spec 65 Phase 1).
 *
 * Covers: get/require/has/toJSON, extend semantics (parent wins, system
 * overrides, `_`-prefix stripping), createExecutionMeta factory
 * (system-key merge, non-serializable filtering, 8 KB size limit),
 * toJSON shallow-copy guarantee.
 */

import { describe, expect, test } from "bun:test";
import {
  createExecutionMeta,
  DEFAULT_META_MAX_BYTES,
  ExecutionMetaImpl,
  extendExecutionMeta,
  MetaSizeError,
} from "../src/types/execution-meta";

describe("ExecutionMetaImpl", () => {
  describe("read accessors", () => {
    test("get returns value for existing key", () => {
      const meta = new ExecutionMetaImpl({ foo: "bar", num: 42 });
      expect(meta.get<string>("foo")).toBe("bar");
      expect(meta.get<number>("num")).toBe(42);
    });

    test("get returns undefined for missing key", () => {
      const meta = new ExecutionMetaImpl({ foo: "bar" });
      expect(meta.get("missing")).toBeUndefined();
    });

    test("has returns true for existing key, false otherwise", () => {
      const meta = new ExecutionMetaImpl({ foo: "bar" });
      expect(meta.has("foo")).toBe(true);
      expect(meta.has("missing")).toBe(false);
    });

    test("require returns value for existing key", () => {
      const meta = new ExecutionMetaImpl({ foo: "bar" });
      expect(meta.require<string>("foo")).toBe("bar");
    });

    test("require throws for missing key", () => {
      const meta = new ExecutionMetaImpl({ foo: "bar" });
      expect(() => meta.require("missing")).toThrow(/Required meta key "missing" not found/);
    });

    test("toJSON returns all entries as a shallow copy", () => {
      const meta = new ExecutionMetaImpl({ a: 1, b: "two" });
      expect(meta.toJSON()).toEqual({ a: 1, b: "two" });
    });

    test("toJSON result is independent — mutating it does not affect meta", () => {
      const meta = new ExecutionMetaImpl({ foo: "bar" });
      const snapshot = meta.toJSON();
      snapshot.foo = "mutated";
      snapshot.extra = "added";
      expect(meta.get("foo")).toBe("bar");
      expect(meta.has("extra")).toBe(false);
    });
  });

  describe("extend", () => {
    test("parent keys always win over extra", () => {
      const parent = new ExecutionMetaImpl({ bulk: true, source: "import" });
      const child = parent.extend({ bulk: false, new_key: "added" });
      expect(child.get("bulk")).toBe(true); // parent wins
      expect(child.get("source")).toBe("import");
      expect(child.get("new_key")).toBe("added");
    });

    test("systemOverrides always applied, even when key exists in parent", () => {
      const parent = new ExecutionMetaImpl({ _depth: 0, user: "alice" });
      const child = parent.extend({}, { _depth: 1, _source_action: "parent_action" });
      expect(child.get<number>("_depth")).toBe(1);
      expect(child.get<string>("_source_action")).toBe("parent_action");
      expect(child.get<string>("user")).toBe("alice");
    });

    test("`_`-prefixed keys in extra are silently dropped", () => {
      const parent = new ExecutionMetaImpl({ _channel: "rest" });
      const child = parent.extend({
        _channel: "evil", // dropped because `_`-prefixed
        _mcp_client_id: "evil_client", // dropped
        legitimate: "kept",
      });
      expect(child.get("_channel")).toBe("rest"); // parent preserved
      expect(child.has("_mcp_client_id")).toBe(false);
      expect(child.get("legitimate")).toBe("kept");
    });

    test("extend returns a new instance — parent unchanged", () => {
      const parent = new ExecutionMetaImpl({ a: 1 });
      const child = parent.extend({ b: 2 });
      expect(parent.has("b")).toBe(false);
      expect(child.get("a")).toBe(1);
      expect(child.get("b")).toBe(2);
    });

    test("extend preserves all parent keys even when systemOverrides supplies same key", () => {
      const parent = new ExecutionMetaImpl({ _depth: 0, _source_action: "root" });
      const child = parent.extend({}, { _depth: 1 });
      expect(child.get<number>("_depth")).toBe(1); // override applied
      expect(child.get<string>("_source_action")).toBe("root"); // untouched
    });
  });
});

describe("extendExecutionMeta helper", () => {
  test("delegates to ExecutionMetaImpl.extend when given an impl instance", () => {
    const parent = new ExecutionMetaImpl({ a: 1 });
    const child = extendExecutionMeta(parent, { b: 2 }, { _depth: 3 });
    expect(child.get("a")).toBe(1);
    expect(child.get("b")).toBe(2);
    expect(child.get("_depth")).toBe(3);
  });

  test("reconstructs from toJSON for non-impl ExecutionMeta implementations", () => {
    // Simulate a foreign ExecutionMeta that isn't an ExecutionMetaImpl.
    const fake = {
      get: <T>(k: string): T | undefined => (({ x: 1 }) as Record<string, unknown>)[k] as T,
      require: <T>(k: string): T => (({ x: 1 }) as Record<string, unknown>)[k] as T,
      has: (k: string) => k === "x",
      toJSON: () => ({ x: 1 }),
    };
    const child = extendExecutionMeta(fake, { y: 2 });
    expect(child.get("x")).toBe(1);
    expect(child.get("y")).toBe(2);
  });
});

describe("createExecutionMeta", () => {
  test("strips `_`-prefixed keys from raw input", () => {
    const meta = createExecutionMeta({
      raw: {
        _channel: "evil",
        _execution_id: "spoofed",
        source_view: "approval_queue",
      },
    });
    expect(meta.has("_channel")).toBe(false);
    expect(meta.has("_execution_id")).toBe(false);
    expect(meta.get("source_view")).toBe("approval_queue");
  });

  test("merges systemKeys on top of raw (system wins)", () => {
    const meta = createExecutionMeta({
      raw: { source_view: "queue" },
      systemKeys: {
        _channel: "rest",
        _execution_id: "exec_abc",
        _depth: 0,
      },
    });
    expect(meta.get("_channel")).toBe("rest");
    expect(meta.get("_execution_id")).toBe("exec_abc");
    expect(meta.get<number>("_depth")).toBe(0);
    expect(meta.get("source_view")).toBe("queue");
  });

  test("external caller cannot set system key via raw", () => {
    const meta = createExecutionMeta({
      raw: { _channel: "spoofed" },
      systemKeys: { _channel: "rest" },
    });
    expect(meta.get("_channel")).toBe("rest");
  });

  test("drops non-serializable values (function, Symbol)", () => {
    const meta = createExecutionMeta({
      raw: {
        good: "value",
        fn: () => 42,
        sym: Symbol("x"),
        bi: BigInt(1),
      },
    });
    expect(meta.get("good")).toBe("value");
    expect(meta.has("fn")).toBe(false);
    expect(meta.has("sym")).toBe(false);
    expect(meta.has("bi")).toBe(false);
  });

  test("drops circular references", () => {
    const circular: Record<string, unknown> = { name: "x" };
    circular.self = circular;
    const meta = createExecutionMeta({
      raw: { ok: "fine", bad: circular },
    });
    expect(meta.get("ok")).toBe("fine");
    expect(meta.has("bad")).toBe(false);
  });

  test("drops class instances (non-plain objects)", () => {
    class Thing {
      x = 1;
    }
    const meta = createExecutionMeta({
      raw: { instance: new Thing(), plain: { a: 1 } },
    });
    expect(meta.has("instance")).toBe(false);
    expect(meta.get("plain")).toEqual({ a: 1 });
  });

  test("preserves arrays and nested plain objects", () => {
    const meta = createExecutionMeta({
      raw: {
        list: [1, 2, 3],
        nested: { a: { b: "c" } },
      },
    });
    expect(meta.get("list")).toEqual([1, 2, 3]);
    expect(meta.get("nested")).toEqual({ a: { b: "c" } });
  });

  test("throws MetaSizeError when payload exceeds 8 KB", () => {
    const big = "x".repeat(DEFAULT_META_MAX_BYTES + 1);
    expect(() => createExecutionMeta({ raw: { big } })).toThrow(MetaSizeError);
  });

  test("MetaSizeError carries size/max + `META.SIZE_EXCEEDED` code", () => {
    const big = "x".repeat(DEFAULT_META_MAX_BYTES + 100);
    try {
      createExecutionMeta({ raw: { big } });
      expect(true).toBe(false); // unreachable
    } catch (err) {
      expect(err).toBeInstanceOf(MetaSizeError);
      const mse = err as MetaSizeError;
      expect(mse.code).toBe("META.SIZE_EXCEEDED");
      expect(mse.sizeBytes).toBeGreaterThan(DEFAULT_META_MAX_BYTES);
      expect(mse.maxBytes).toBe(DEFAULT_META_MAX_BYTES);
    }
  });

  test("accepts custom maxSizeBytes", () => {
    expect(() =>
      createExecutionMeta({
        raw: { x: "ab".repeat(50) },
        maxSizeBytes: 32,
      }),
    ).toThrow(MetaSizeError);
  });

  test("empty options produce an empty but valid meta", () => {
    const meta = createExecutionMeta();
    expect(meta.toJSON()).toEqual({});
  });

  // Codex follow-up: nested values must be recursively validated. A Date or
  // function embedded inside an otherwise-plain object was previously passing
  // the filter because JSON.stringify tolerated it — handlers then observed
  // a live Date/function that diverged from `meta.toJSON()`.
  test("recursively drops keys containing nested Date / class instance", () => {
    const meta = createExecutionMeta({
      raw: {
        nestedDate: { when: new Date() },
        nestedClass: { inst: new (class {})() },
        nestedFn: { cb: () => 1 },
        nestedOk: { a: { b: "c" } },
      },
    });
    expect(meta.has("nestedDate")).toBe(false);
    expect(meta.has("nestedClass")).toBe(false);
    expect(meta.has("nestedFn")).toBe(false);
    expect(meta.get("nestedOk")).toEqual({ a: { b: "c" } });
  });

  test("recursively drops arrays whose elements are non-serializable", () => {
    const meta = createExecutionMeta({
      raw: {
        arrWithFn: [1, () => 2, 3],
        arrClean: [1, 2, 3],
      },
    });
    expect(meta.has("arrWithFn")).toBe(false);
    expect(meta.get("arrClean")).toEqual([1, 2, 3]);
  });
});

// Codex follow-up: extend() must apply the same filter + size limit so nested
// ctx.execute meta cannot smuggle non-serializable values or exceed 8 KB.
describe("ExecutionMetaImpl.extend safety", () => {
  test("extend drops non-serializable extra keys", () => {
    const parent = new ExecutionMetaImpl({ a: 1 });
    const child = parent.extend({ bad: () => 1, date: new Date(), ok: "yes" });
    expect(child.has("bad")).toBe(false);
    expect(child.has("date")).toBe(false);
    expect(child.get("ok")).toBe("yes");
  });

  test("extend drops extras whose nested values are non-serializable", () => {
    const parent = new ExecutionMetaImpl({ a: 1 });
    const child = parent.extend({ nested: { when: new Date() } });
    expect(child.has("nested")).toBe(false);
  });

  test("extend enforces size limit inherited from parent", () => {
    const parent = new ExecutionMetaImpl({ a: 1 });
    expect(() => parent.extend({ huge: "x".repeat(DEFAULT_META_MAX_BYTES + 1) })).toThrow(
      MetaSizeError,
    );
  });

  test("extendExecutionMeta enforces size on non-ExecutionMetaImpl parent", () => {
    const fakeParent = {
      get: () => undefined,
      require: () => undefined,
      has: () => false,
      toJSON: () => ({ a: 1 }),
    };
    expect(() =>
      extendExecutionMeta(fakeParent, { huge: "x".repeat(DEFAULT_META_MAX_BYTES + 1) }),
    ).toThrow(MetaSizeError);
  });

  test("custom size limit from constructor is honored by extend", () => {
    const parent = new ExecutionMetaImpl({ a: 1 }, 64);
    expect(() => parent.extend({ big: "x".repeat(200) })).toThrow(MetaSizeError);
  });
});

// Codex round-2 follow-up: shared subobject references must not be classified
// as circular, and nested values must be detached from caller + read-only to handlers.
describe("ExecutionMeta read-only + shared-ref handling", () => {
  test("shared sibling subobjects are accepted (not mis-detected as circular)", () => {
    const shared = { s: "y" };
    const meta = createExecutionMeta({
      raw: {
        payload: { a: shared, b: shared },
        items: [shared, shared, shared],
      },
    });
    expect(meta.has("payload")).toBe(true);
    expect(meta.has("items")).toBe(true);
    const items = meta.get<unknown[]>("items");
    expect(items?.length).toBe(3);
  });

  test("true circular reference still rejected", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const meta = createExecutionMeta({
      raw: {
        bad: cyclic,
        good: "kept",
      },
    });
    expect(meta.has("bad")).toBe(false);
    expect(meta.get("good")).toBe("kept");
  });

  test("construction detaches from caller's object graph", () => {
    const raw = { nested: { count: 1 } };
    const meta = createExecutionMeta({ raw });
    // Mutating the caller's original does NOT affect the stored meta.
    (raw.nested as { count: number }).count = 999;
    const stored = meta.get<{ count: number }>("nested");
    expect(stored?.count).toBe(1);
  });

  test("values returned from get() are frozen — handler mutation is rejected", () => {
    const meta = createExecutionMeta({ raw: { nested: { count: 1 } } });
    const view = meta.get<{ count: number }>("nested");
    expect(view).toBeDefined();
    expect(Object.isFrozen(view)).toBe(true);
    // Strict-mode throws on write to frozen property (ES modules = strict mode).
    expect(() => {
      if (view) view.count = 999;
    }).toThrow();
    expect(meta.get<{ count: number }>("nested")?.count).toBe(1);
  });

  test("values inside toJSON() snapshot are frozen at nested levels", () => {
    const meta = createExecutionMeta({ raw: { nested: { a: 1 } } });
    const snap = meta.toJSON();
    // Top level of snapshot is a fresh Object (from Object.fromEntries) —
    // mutable; the existing "toJSON returns a shallow copy" test documents this.
    snap.extra = "ok"; // allowed
    expect("extra" in snap).toBe(true);
    // Nested values remain frozen — cannot mutate through the snapshot either.
    const nestedInSnap = snap.nested as { a: number };
    expect(Object.isFrozen(nestedInSnap)).toBe(true);
    expect(() => {
      nestedInSnap.a = 999;
    }).toThrow();
    // And the meta itself is unchanged.
    expect(meta.get<{ a: number }>("nested")?.a).toBe(1);
  });

  test("arrays in meta are frozen — push / index assignment rejected", () => {
    const meta = createExecutionMeta({ raw: { list: [1, 2, 3] } });
    const list = meta.get<number[]>("list");
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => list?.push(4)).toThrow();
    expect(meta.get<number[]>("list")?.length).toBe(3);
  });
});

// Codex round-5: invariants must hold for any `new ExecutionMetaImpl(...)`
// instantiation, not only the factory — the class is publicly exported.
describe("ExecutionMetaImpl constructor self-enforcement", () => {
  test("constructor enforces 8 KB size limit directly", () => {
    expect(() => new ExecutionMetaImpl({ big: "x".repeat(DEFAULT_META_MAX_BYTES + 1) })).toThrow(
      MetaSizeError,
    );
  });

  test("constructor filters non-JSON-serializable values", () => {
    const meta = new ExecutionMetaImpl({
      good: "keep",
      fn: () => 1,
      date: new Date(),
      nan: Number.NaN,
    });
    expect(meta.get("good")).toBe("keep");
    expect(meta.has("fn")).toBe(false);
    expect(meta.has("date")).toBe(false);
    expect(meta.has("nan")).toBe(false);
  });

  test("constructor honors custom maxBytes", () => {
    expect(() => new ExecutionMetaImpl({ text: "x".repeat(100) }, 32)).toThrow(MetaSizeError);
  });

  // Non-finite numbers (NaN, Infinity, -Infinity) serialize to `null`, which
  // would diverge from what handlers read in memory.
  test("createExecutionMeta drops NaN and Infinity", () => {
    const meta = createExecutionMeta({
      raw: {
        n: Number.NaN,
        p: Number.POSITIVE_INFINITY,
        neg: Number.NEGATIVE_INFINITY,
        ok: 42,
      },
    });
    expect(meta.has("n")).toBe(false);
    expect(meta.has("p")).toBe(false);
    expect(meta.has("neg")).toBe(false);
    expect(meta.get("ok")).toBe(42);
  });

  test("nested NaN causes the whole key to be dropped", () => {
    const meta = createExecutionMeta({
      raw: {
        bad: { inner: Number.NaN },
        okay: { inner: 1 },
      },
    });
    expect(meta.has("bad")).toBe(false);
    expect(meta.get("okay")).toEqual({ inner: 1 });
  });
});
