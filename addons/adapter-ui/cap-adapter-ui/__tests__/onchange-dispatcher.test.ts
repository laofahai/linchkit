/**
 * OnchangeDispatcher tests (Spec 64 §6.1 front-end integration).
 *
 * Covers:
 *   - field changes fire the fetcher after debounce
 *   - returned `updates` are applied; `warnings` are surfaced
 *   - stale responses are dropped when a newer call lands first
 *   - in-flight request is aborted when superseded
 *   - network errors don't crash and the loading flag clears
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OnchangeDefinition } from "@linchkit/core/types";
import {
  buildOnchangeIndex,
  OnchangeDispatcher,
  type OnchangeFetcher,
} from "../src/lib/onchange-dispatcher";

const onchangeMap: Record<string, OnchangeDefinition> = {
  product_id: {
    updates: ["unit_price", "uom"],
    compute: () => ({}),
  },
  "quantity,unit_price": {
    updates: ["subtotal"],
    compute: () => ({}),
  },
};

function makeFixture(overrides: { fetcher?: OnchangeFetcher; debounceMs?: number } = {}) {
  let values: Record<string, unknown> = { quantity: 1, unit_price: 0, subtotal: 0 };
  const updatesLog: Array<Record<string, unknown>> = [];
  const warningsLog: string[][] = [];
  const loadingLog: Array<{ loading: boolean; pending: string[] }> = [];
  const defaultFetcher: OnchangeFetcher = async () => ({ updates: {} });

  const dispatcher = new OnchangeDispatcher({
    entity: "purchase_item",
    onchange: onchangeMap,
    getValues: () => values,
    onUpdates: (u) => {
      updatesLog.push(u);
      values = { ...values, ...u };
    },
    onWarnings: (w) => warningsLog.push(w),
    onLoadingChange: (l, p) =>
      loadingLog.push({ loading: l, pending: [...p].sort((a, b) => a.localeCompare(b)) }),
    fetcher: overrides.fetcher ?? defaultFetcher,
    debounceMs: overrides.debounceMs ?? 0,
  });

  return {
    dispatcher,
    updatesLog,
    warningsLog,
    loadingLog,
    setValues: (v: Record<string, unknown>) => {
      values = v;
    },
    getValues: () => values,
  };
}

describe("buildOnchangeIndex", () => {
  test("indexes single-field triggers", () => {
    const idx = buildOnchangeIndex({
      product_id: { updates: ["unit_price"], compute: () => ({}) },
    });
    expect(idx.get("product_id")).toEqual(["unit_price"]);
  });

  test("explodes comma-separated triggers", () => {
    const idx = buildOnchangeIndex(onchangeMap);
    expect(idx.get("quantity")).toEqual(["subtotal"]);
    expect(idx.get("unit_price")).toContain("subtotal");
  });

  test("merges updates when the same trigger appears in multiple keys", () => {
    const idx = buildOnchangeIndex({
      a: { updates: ["x"], compute: () => ({}) },
      "a,b": { updates: ["y"], compute: () => ({}) },
    });
    const aUpdates = idx.get("a");
    expect(aUpdates).toContain("x");
    expect(aUpdates).toContain("y");
    expect(idx.get("b")).toEqual(["y"]);
  });

  test("returns empty map when onchange is undefined", () => {
    expect(buildOnchangeIndex(undefined).size).toBe(0);
  });
});

describe("OnchangeDispatcher.trigger", () => {
  test("no-op when no hook matches the field", async () => {
    const fetcher = mock(async () => ({ updates: {} }));
    const fx = makeFixture({ fetcher });
    fx.dispatcher.trigger("description"); // no hook
    await new Promise((r) => setTimeout(r, 5));
    expect(fetcher).toHaveBeenCalledTimes(0);
  });

  test("debounce coalesces rapid calls into a single fetch with the LATEST field", async () => {
    const calls: string[] = [];
    const fetcher: OnchangeFetcher = async ({ changedField }) => {
      calls.push(changedField);
      return { updates: {} };
    };
    const fx = makeFixture({ fetcher, debounceMs: 20 });
    fx.dispatcher.trigger("quantity");
    fx.dispatcher.trigger("unit_price");
    fx.dispatcher.trigger("product_id");
    expect(calls).toEqual([]); // not flushed yet
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toEqual(["product_id"]);
  });

  test("applies returned `updates` to form state", async () => {
    const fetcher: OnchangeFetcher = async () => ({
      updates: { unit_price: 29.99, uom: "piece" },
    });
    const fx = makeFixture({ fetcher });
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    expect(fx.updatesLog).toEqual([{ unit_price: 29.99, uom: "piece" }]);
    expect(fx.getValues().unit_price).toBe(29.99);
  });

  test("forwards warnings to onWarnings", async () => {
    const fetcher: OnchangeFetcher = async () => ({
      updates: {},
      warnings: ["Exchange rate is stale"],
    });
    const fx = makeFixture({ fetcher });
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    expect(fx.warningsLog).toEqual([["Exchange rate is stale"]]);
  });

  test("toggles loading state around the request", async () => {
    let resolve!: (value: { updates: Record<string, unknown> }) => void;
    const fetcher: OnchangeFetcher = () =>
      new Promise((r) => {
        resolve = r;
      });
    const fx = makeFixture({ fetcher });
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    expect(fx.loadingLog.at(-1)?.loading).toBe(true);
    expect(fx.loadingLog.at(-1)?.pending).toEqual(["unit_price", "uom"].sort());
    resolve({ updates: { unit_price: 1 } });
    await new Promise((r) => setTimeout(r, 5));
    expect(fx.loadingLog.at(-1)?.loading).toBe(false);
  });
});

describe("OnchangeDispatcher race protection", () => {
  test("stale response is dropped when a newer call lands first", async () => {
    // First call resolves slowly with seq=1, second resolves quickly with seq=2.
    let firstResolve!: (v: { updates: Record<string, unknown> }) => void;
    let callIndex = 0;
    const fetcher: OnchangeFetcher = () => {
      const i = callIndex++;
      if (i === 0) {
        return new Promise((r) => {
          firstResolve = r;
        });
      }
      return Promise.resolve({ updates: { unit_price: 99 } });
    };
    const fx = makeFixture({ fetcher, debounceMs: 0 });
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    // Second trigger fires while first is in-flight. Dispatcher aborts first.
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    expect(fx.updatesLog).toEqual([{ unit_price: 99 }]);
    // Late delivery of the FIRST request must NOT clobber form state.
    firstResolve({ unit_price: 1, uom: "stale" } as unknown as {
      updates: Record<string, unknown>;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(fx.updatesLog).toEqual([{ unit_price: 99 }]);
  });

  test("AbortController is signaled when a request is superseded", async () => {
    const aborted: boolean[] = [];
    const fetcher: OnchangeFetcher = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted.push(true);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const fx = makeFixture({ fetcher, debounceMs: 0 });
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    fx.dispatcher.trigger("product_id"); // supersedes the first
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted.length).toBe(1);
  });

  test("cancel() aborts pending debounce and in-flight request", async () => {
    let aborted = false;
    const fetcher: OnchangeFetcher = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const fx = makeFixture({ fetcher, debounceMs: 0 });
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    fx.dispatcher.cancel();
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
    expect(fx.loadingLog.at(-1)?.loading).toBe(false);
  });
});

describe("OnchangeDispatcher error tolerance", () => {
  let originalError: typeof console.error;
  beforeEach(() => {
    originalError = console.error;
    console.error = mock(() => {});
  });
  afterEach(() => {
    console.error = originalError;
  });

  test("network error does not throw and clears loading", async () => {
    const fetcher: OnchangeFetcher = async () => {
      throw new Error("network down");
    };
    const fx = makeFixture({ fetcher });
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    expect(fx.updatesLog).toEqual([]);
    expect(fx.loadingLog.at(-1)?.loading).toBe(false);
  });

  test("abort errors are silent (no console output)", async () => {
    const fetcher: OnchangeFetcher = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    const fx = makeFixture({ fetcher });
    fx.dispatcher.trigger("product_id");
    await new Promise((r) => setTimeout(r, 5));
    expect((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});
