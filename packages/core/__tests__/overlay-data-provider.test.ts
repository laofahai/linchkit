/**
 * OverlayAwareDataProvider + DefaultOverlayRegistry — unit tests
 *
 * Tests the data provider wrapper that handles overlay field separation
 * (_extensions JSONB) and spreading on read.
 * Uses InMemoryStore as the inner provider.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { DataProvider, DataQueryOptions } from "../src/engine/action-engine";
import { DefaultOverlayRegistry } from "../src/overlay/overlay-registry";
import { InMemoryOverlayStore } from "../src/persistence/in-memory-overlay-store";
import { InMemoryStore } from "../src/persistence/in-memory-store";
import { OverlayAwareDataProvider } from "../src/persistence/overlay-aware-data-provider";

describe("DefaultOverlayRegistry (cache behavior)", () => {
  let overlayStore: InMemoryOverlayStore;
  let registry: DefaultOverlayRegistry;

  beforeEach(() => {
    overlayStore = new InMemoryOverlayStore();
    registry = new DefaultOverlayRegistry(overlayStore);
  });

  test("initialize loads all active overlays into cache", async () => {
    await overlayStore.addOverlay({
      entityName: "order",
      fieldName: "color",
      fieldType: "string",
      config: {},
      status: "active",
    });
    await overlayStore.addOverlay({
      entityName: "order",
      fieldName: "priority",
      fieldType: "number",
      config: {},
      status: "active",
    });
    await overlayStore.addOverlay({
      entityName: "product",
      fieldName: "weight",
      fieldType: "number",
      config: {},
      status: "active",
    });
    // Deprecated overlay should not appear
    await overlayStore.addOverlay({
      entityName: "order",
      fieldName: "old_field",
      fieldType: "string",
      config: {},
      status: "deprecated",
    });

    await registry.initialize();

    expect(registry.overlaysFor("order")).toHaveLength(2);
    expect(registry.overlaysFor("product")).toHaveLength(1);
    expect(registry.overlaysFor("nonexistent")).toHaveLength(0);
  });

  test("register persists to store and updates cache", async () => {
    const record = await registry.register({
      entityName: "order",
      fieldName: "color",
      fieldType: "string",
      config: { label: { en: "Color" } },
      status: "active",
    });

    expect(record.id).toBeDefined();
    expect(record.fieldName).toBe("color");

    // Cache should be updated
    const cached = registry.overlaysFor("order");
    expect(cached).toHaveLength(1);
    expect(cached[0]?.fieldName).toBe("color");

    // Store should also have it
    const stored = await overlayStore.getOverlays("order");
    expect(stored).toHaveLength(1);
  });

  test("update persists and refreshes cache", async () => {
    const record = await registry.register({
      entityName: "order",
      fieldName: "color",
      fieldType: "string",
      config: {},
      status: "active",
    });

    const updated = await registry.update(record.id, {
      config: { description: "Updated" },
    });

    expect(updated.config).toEqual({ description: "Updated" });

    const cached = registry.overlaysFor("order");
    expect(cached[0]?.config).toEqual({ description: "Updated" });
  });

  test("deprecate removes from active cache", async () => {
    const record = await registry.register({
      entityName: "order",
      fieldName: "color",
      fieldType: "string",
      config: {},
      status: "active",
    });

    await registry.deprecate(record.id);

    // Should no longer appear in overlaysFor (only active overlays)
    expect(registry.overlaysFor("order")).toHaveLength(0);
  });

  test("onChange notifies listeners", async () => {
    let notifiedEntity: string | undefined;
    registry.onChange((entityName) => {
      notifiedEntity = entityName;
    });

    await registry.register({
      entityName: "order",
      fieldName: "color",
      fieldType: "string",
      config: {},
      status: "active",
    });

    expect(notifiedEntity).toBe("order");
  });
});

describe("OverlayAwareDataProvider", () => {
  let innerStore: InMemoryStore;
  let overlayStore: InMemoryOverlayStore;
  let registry: DefaultOverlayRegistry;
  let provider: OverlayAwareDataProvider;

  beforeEach(async () => {
    innerStore = new InMemoryStore();
    overlayStore = new InMemoryOverlayStore();
    registry = new DefaultOverlayRegistry(overlayStore);

    // Register overlay fields for the "order" entity
    await registry.register({
      entityName: "order",
      fieldName: "custom_color",
      fieldType: "string",
      config: { label: { en: "Color" } },
      status: "active",
    });
    await registry.register({
      entityName: "order",
      fieldName: "priority_score",
      fieldType: "number",
      config: { min: 0, max: 100 },
      status: "active",
    });

    provider = new OverlayAwareDataProvider(innerStore, registry);
  });

  // ── Create ──────────────────────────────────────────────────

  test("create separates overlay fields into _extensions", async () => {
    const result = await provider.create("order", {
      title: "Test Order",
      custom_color: "red",
      priority_score: 75,
    });

    // Result should have overlay fields at root (spread from _extensions)
    expect(result.title).toBe("Test Order");
    expect(result.custom_color).toBe("red");
    expect(result.priority_score).toBe(75);
    expect(result._extensions).toBeUndefined();

    // Verify inner store has _extensions
    const raw = await innerStore.get("order", result.id as string);
    expect(raw._extensions).toEqual({
      custom_color: "red",
      priority_score: 75,
    });
    // Core field should NOT be in _extensions
    expect((raw._extensions as Record<string, unknown>).title).toBeUndefined();
  });

  test("create with no overlay fields passes through normally", async () => {
    const result = await provider.create("order", {
      title: "Plain Order",
    });

    expect(result.title).toBe("Plain Order");

    // No _extensions should be set
    const raw = await innerStore.get("order", result.id as string);
    expect(raw._extensions).toBeUndefined();
  });

  test("create for entity without overlays passes through unchanged", async () => {
    const result = await provider.create("product", {
      name: "Widget",
      price: 9.99,
    });

    expect(result.name).toBe("Widget");
    expect(result.price).toBe(9.99);
  });

  // ── Get ─────────────────────────────────────────────────────

  test("get spreads _extensions into root", async () => {
    // Seed raw data with _extensions (simulating Drizzle-stored data)
    innerStore.seed("order", [
      {
        id: "order-1",
        title: "Seeded Order",
        _extensions: { custom_color: "blue", priority_score: 50 },
      },
    ]);

    const result = await provider.get("order", "order-1");

    expect(result.title).toBe("Seeded Order");
    expect(result.custom_color).toBe("blue");
    expect(result.priority_score).toBe(50);
    expect(result._extensions).toBeUndefined();
  });

  test("get with no _extensions returns record as-is", async () => {
    innerStore.seed("order", [{ id: "order-2", title: "No Extensions" }]);

    const result = await provider.get("order", "order-2");
    expect(result.title).toBe("No Extensions");
    expect(result._extensions).toBeUndefined();
  });

  // ── Update ──────────────────────────────────────────────────

  test("update overlay fields merges into _extensions", async () => {
    // Create with initial overlay values
    const created = await provider.create("order", {
      title: "Order A",
      custom_color: "red",
      priority_score: 30,
    });

    // Update only one overlay field
    const updated = await provider.update("order", created.id as string, {
      priority_score: 90,
    });

    expect(updated.priority_score).toBe(90);
    // Previously set overlay field should be preserved
    expect(updated.custom_color).toBe("red");
    expect(updated.title).toBe("Order A");
    expect(updated._extensions).toBeUndefined();

    // Verify raw storage
    const raw = await innerStore.get("order", created.id as string);
    expect(raw._extensions).toEqual({
      custom_color: "red",
      priority_score: 90,
    });
  });

  test("update core fields does not affect _extensions", async () => {
    const created = await provider.create("order", {
      title: "Order B",
      custom_color: "green",
    });

    const updated = await provider.update("order", created.id as string, {
      title: "Order B Updated",
    });

    expect(updated.title).toBe("Order B Updated");
    expect(updated.custom_color).toBe("green");
  });

  test("update with mixed core and overlay fields works correctly", async () => {
    const created = await provider.create("order", {
      title: "Mixed Order",
      custom_color: "yellow",
    });

    const updated = await provider.update("order", created.id as string, {
      title: "Mixed Order Updated",
      custom_color: "purple",
      priority_score: 42,
    });

    expect(updated.title).toBe("Mixed Order Updated");
    expect(updated.custom_color).toBe("purple");
    expect(updated.priority_score).toBe(42);
  });

  // ── Query ───────────────────────────────────────────────────

  test("query spreads _extensions on all results", async () => {
    innerStore.seed("order", [
      {
        id: "q-1",
        title: "Order 1",
        status: "pending",
        _extensions: { custom_color: "red" },
      },
      {
        id: "q-2",
        title: "Order 2",
        status: "pending",
        _extensions: { custom_color: "blue" },
      },
    ]);

    const results = await provider.query("order", { status: "pending" });
    expect(results).toHaveLength(2);
    expect(results[0]?.custom_color).toBe("red");
    expect(results[1]?.custom_color).toBe("blue");
    expect(results[0]?._extensions).toBeUndefined();
  });

  // ── Count ───────────────────────────────────────────────────

  test("count delegates to inner provider", async () => {
    await provider.create("order", { title: "A" });
    await provider.create("order", { title: "B" });

    const count = await provider.count("order");
    expect(count).toBe(2);
  });

  // ── Delete ──────────────────────────────────────────────────

  test("delete delegates to inner provider", async () => {
    const created = await provider.create("order", {
      title: "To Delete",
      custom_color: "red",
    });

    await provider.delete("order", created.id as string);

    // Soft-deleted, so count should be 0
    const count = await provider.count("order");
    expect(count).toBe(0);
  });

  // ── Edge cases ──────────────────────────────────────────────

  test("system fields are never treated as overlay fields", async () => {
    const result = await provider.create("order", {
      title: "System Fields Test",
      custom_color: "red",
      tenant_id: "tenant-123",
    });

    // tenant_id should be at root, not in _extensions
    const raw = await innerStore.get("order", result.id as string);
    expect(raw.tenant_id).toBe("tenant-123");
    expect((raw._extensions as Record<string, unknown>)?.tenant_id).toBeUndefined();
  });

  test("create roundtrip preserves all field values", async () => {
    const created = await provider.create("order", {
      title: "Roundtrip",
      custom_color: "magenta",
      priority_score: 99,
      notes: "some notes",
    });

    const fetched = await provider.get("order", created.id as string);

    expect(fetched.title).toBe("Roundtrip");
    expect(fetched.custom_color).toBe("magenta");
    expect(fetched.priority_score).toBe(99);
    expect(fetched.notes).toBe("some notes");
  });

  test("deprecated overlay no longer separates fields", async () => {
    // Deprecate one overlay
    const overlays = registry.overlaysFor("order");
    const colorOverlay = overlays.find((o) => o.fieldName === "custom_color");
    if (colorOverlay) {
      await registry.deprecate(colorOverlay.id);
    }

    const result = await provider.create("order", {
      title: "Deprecated Test",
      custom_color: "red",
      priority_score: 50,
    });

    // custom_color is deprecated, so it should go to core columns (not _extensions)
    const raw = await innerStore.get("order", result.id as string);
    expect(raw.custom_color).toBe("red");
    // Only active overlay (priority_score) should be in _extensions
    expect(raw._extensions).toEqual({ priority_score: 50 });
  });
});

// ── withConnection (transaction-scoped wrapper) ─────────────────
//
// Issue #156: `OverlayAwareDataProvider` must survive the transactional
// path so `DrizzleTransactionManager` can keep the wrapper in flight when
// it spawns a tx-scoped DataProvider via `withConnection(tx)`.

/**
 * Inner DataProvider that records every operation against a per-instance
 * transcript and exposes a `withConnection(client)` factory which produces
 * a sibling instance sharing nothing but its parent's transcript root.
 * Lets us assert that the wrapper's `withConnection` returns a NEW wrapper
 * that delegates to the inner provider's tx-scoped copy.
 */
class TrackingProvider implements DataProvider {
  readonly id: string;
  readonly receivedClients: unknown[] = [];
  readonly children: TrackingProvider[] = [];
  readonly inner: InMemoryStore;

  constructor(id: string, inner: InMemoryStore = new InMemoryStore()) {
    this.id = id;
    this.inner = inner;
  }

  withConnection(client: unknown): TrackingProvider {
    this.receivedClients.push(client);
    // Share the same backing InMemoryStore so the parent and tx copy see
    // the same data — mirrors how `DrizzleDataProvider.withConnection`
    // returns a sibling provider that talks to the same tables.
    const child = new TrackingProvider(`${this.id}#tx${this.children.length}`, this.inner);
    this.children.push(child);
    return child;
  }

  get = (schema: string, id: string, options?: DataQueryOptions) =>
    this.inner.get(schema, id, options);
  query = (schema: string, filter: Record<string, unknown>, options?: DataQueryOptions) =>
    this.inner.query(schema, filter, options);
  create = (schema: string, data: Record<string, unknown>) => this.inner.create(schema, data);
  update = (
    schema: string,
    id: string,
    data: Record<string, unknown>,
    options?: DataQueryOptions,
  ) => this.inner.update(schema, id, data, options);
  delete = (schema: string, id: string, options?: DataQueryOptions) =>
    this.inner.delete(schema, id, options);
  count = (schema: string, filter?: Record<string, unknown>, options?: DataQueryOptions) =>
    this.inner.count(schema, filter, options);
}

describe("OverlayAwareDataProvider.withConnection (issue #156)", () => {
  let overlayStore: InMemoryOverlayStore;
  let registry: DefaultOverlayRegistry;
  let tracking: TrackingProvider;
  let wrapper: OverlayAwareDataProvider;

  beforeEach(async () => {
    overlayStore = new InMemoryOverlayStore();
    registry = new DefaultOverlayRegistry(overlayStore);
    await registry.register({
      entityName: "order",
      fieldName: "custom_color",
      fieldType: "string",
      config: {},
      status: "active",
    });
    tracking = new TrackingProvider("root");
    wrapper = new OverlayAwareDataProvider(tracking, registry);
  });

  test("withConnection returns a new wrapper that delegates to the inner's tx-scoped provider", () => {
    const fakeClient = { __tx: true };
    const txWrapper = wrapper.withConnection(fakeClient);

    // A NEW wrapper instance — not `this`.
    expect(txWrapper).toBeInstanceOf(OverlayAwareDataProvider);
    expect(txWrapper).not.toBe(wrapper);

    // The inner was asked to spawn a tx-scoped copy with our client.
    expect(tracking.receivedClients).toEqual([fakeClient]);
    expect(tracking.children).toHaveLength(1);
  });

  test("writes through the tx-scoped wrapper still split overlay fields into _extensions", async () => {
    const fakeClient = { __tx: true };
    const txWrapper = wrapper.withConnection(fakeClient);

    const created = await txWrapper.create("order", {
      title: "Tx Order",
      custom_color: "red",
    });

    expect(created.custom_color).toBe("red");
    expect(created._extensions).toBeUndefined();

    // Inspect raw storage on the SHARED InMemoryStore to confirm the
    // overlay field landed in `_extensions`, not as a top-level column.
    const child = tracking.children[0];
    if (!child) throw new Error("expected a tx child");
    const raw = await child.inner.get("order", created.id as string);
    expect(raw._extensions).toEqual({ custom_color: "red" });
    expect(raw.custom_color).toBeUndefined();
  });

  test("reads through the tx-scoped wrapper spread _extensions onto the row root", async () => {
    const fakeClient = { __tx: true };
    const txWrapper = wrapper.withConnection(fakeClient);
    const child = tracking.children[0];
    if (!child) throw new Error("expected a tx child");

    // Seed the underlying store directly so we test the read path in
    // isolation (write path tested separately).
    child.inner.seed("order", [
      {
        id: "tx-1",
        title: "Seeded",
        _extensions: { custom_color: "blue" },
      },
    ]);

    const fetched = await txWrapper.get("order", "tx-1");
    expect(fetched.title).toBe("Seeded");
    expect(fetched.custom_color).toBe("blue");
    expect(fetched._extensions).toBeUndefined();
  });

  test("parent and tx-scoped wrapper share the SAME OverlayRegistry instance", async () => {
    const txWrapper = wrapper.withConnection({ __tx: true });

    // Register a NEW overlay AFTER spawning the tx wrapper. Because both
    // wrappers reference the same registry, the tx wrapper sees the
    // mutation immediately — no re-initialization needed.
    await registry.register({
      entityName: "order",
      fieldName: "priority_score",
      fieldType: "number",
      config: {},
      status: "active",
    });

    const child = tracking.children[0];
    if (!child) throw new Error("expected a tx child");

    const created = await txWrapper.create("order", {
      title: "Late Overlay",
      custom_color: "green",
      priority_score: 7,
    });

    const raw = await child.inner.get("order", created.id as string);
    expect(raw._extensions).toEqual({ custom_color: "green", priority_score: 7 });
  });

  test("withConnection is a no-op for inner providers that don't implement it", async () => {
    // InMemoryStore directly — no `withConnection`. The wrapper must still
    // return a usable wrapper around the SAME inner so test wiring (and the
    // exec.ts non-Drizzle path) keeps working.
    const plainStore = new InMemoryStore();
    const plainWrapper = new OverlayAwareDataProvider(plainStore, registry);
    const txWrapper = plainWrapper.withConnection({ __tx: true });
    expect(txWrapper).toBeInstanceOf(OverlayAwareDataProvider);
    expect(txWrapper).not.toBe(plainWrapper);

    const created = await txWrapper.create("order", {
      title: "No-Conn",
      custom_color: "yellow",
    });
    const raw = await plainStore.get("order", created.id as string);
    expect(raw._extensions).toEqual({ custom_color: "yellow" });
  });
});

describe("DrizzleTransactionManager.wrapForTx integration (issue #156)", () => {
  // We can't construct a real DrizzleTransactionManager without a Postgres
  // client, but we can simulate the same control flow with a fake
  // TransactionManager + the wrapper, which is what dev-wiring relies on.
  // This proves the structural plumbing the dev-wiring depends on.

  test("wrapForTx callback re-applies OverlayAwareDataProvider inside runInTransaction", async () => {
    const overlayStore = new InMemoryOverlayStore();
    const registry = new DefaultOverlayRegistry(overlayStore);
    await registry.register({
      entityName: "order",
      fieldName: "custom_color",
      fieldType: "string",
      config: {},
      status: "active",
    });

    const innerStore = new InMemoryStore();
    const tracking = new TrackingProvider("root", innerStore);

    // Simulate what dev-wiring does: the executor sees the wrapper, the
    // transaction manager applies wrapForTx after `withConnection(tx)`.
    const wrapForTx = (txInner: DataProvider): DataProvider =>
      new OverlayAwareDataProvider(txInner, registry);

    // "tx" path: take the bare provider's tx copy, apply wrapForTx, run a
    // write through it, observe the split.
    const fakeTx = { __tx: true };
    const bareTx = tracking.withConnection(fakeTx);
    const wrappedTx = wrapForTx(bareTx);

    const created = await wrappedTx.create("order", {
      title: "Wrapped Tx",
      custom_color: "purple",
    });

    expect(created.custom_color).toBe("purple");
    const raw = await innerStore.get("order", created.id as string);
    expect(raw._extensions).toEqual({ custom_color: "purple" });
    expect(raw.custom_color).toBeUndefined();
  });
});
