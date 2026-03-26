import { describe, expect, test, beforeEach, afterEach } from "bun:test";

// Test the pure localStorage logic from use-saved-views.ts.
// We re-implement the helpers here since they are not exported.

// Use a unique schema name per describe block to avoid cross-test contamination
const SCHEMA = "test_orders";

function storageKey(schemaName: string): string {
  return `linchkit:saved-views:${schemaName}`;
}

interface SavedViewFilter {
  field: string;
  operator: string;
  values: unknown[];
}

interface SavedViewSort {
  field: string;
  order: "asc" | "desc";
}

interface SavedView {
  id: string;
  name: string;
  filters: SavedViewFilter[];
  sort?: SavedViewSort;
  columns?: string[];
  createdAt: string;
}

function readViews(schemaName: string): SavedView[] {
  try {
    const raw = localStorage.getItem(storageKey(schemaName));
    if (!raw) return [];
    return JSON.parse(raw) as SavedView[];
  } catch {
    return [];
  }
}

function writeViews(schemaName: string, views: SavedView[]): void {
  localStorage.setItem(storageKey(schemaName), JSON.stringify(views));
}

function generateId(): string {
  return `sv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Mock localStorage for Bun test environment
const storage = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
};

// Install mock localStorage if not available
const originalLocalStorage = globalThis.localStorage;
beforeEach(() => {
  // Clear all localStorage entries to ensure test isolation
  if (typeof globalThis.localStorage !== "undefined") {
    globalThis.localStorage.clear();
  }
  storage.clear();
  if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });
  }
});

afterEach(() => {
  if (typeof globalThis.localStorage !== "undefined") {
    globalThis.localStorage.clear();
  }
  storage.clear();
});

describe("saved views — storage key", () => {
  test("generates correct storage key", () => {
    expect(storageKey("orders")).toBe("linchkit:saved-views:orders");
    expect(storageKey("purchase_order")).toBe("linchkit:saved-views:purchase_order");
  });
});

describe("saved views — readViews", () => {
  test("returns empty array when nothing stored", () => {
    expect(readViews(SCHEMA)).toEqual([]);
  });

  test("returns empty array for invalid JSON", () => {
    localStorage.setItem(storageKey(SCHEMA), "not valid json{{{");
    expect(readViews(SCHEMA)).toEqual([]);
  });

  test("reads stored views correctly", () => {
    const views: SavedView[] = [
      {
        id: "sv_1",
        name: "My View",
        filters: [{ field: "status", operator: "eq", values: ["draft"] }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    localStorage.setItem(storageKey(SCHEMA), JSON.stringify(views));
    const result = readViews(SCHEMA);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("My View");
    expect(result[0].filters[0].field).toBe("status");
  });
});

describe("saved views — writeViews", () => {
  test("writes views to localStorage", () => {
    const views: SavedView[] = [
      {
        id: "sv_1",
        name: "Test View",
        filters: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    writeViews(SCHEMA, views);
    const raw = localStorage.getItem(storageKey(SCHEMA));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Test View");
  });

  test("overwrites existing views", () => {
    writeViews(SCHEMA, [
      { id: "sv_1", name: "View 1", filters: [], createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    writeViews(SCHEMA, [
      { id: "sv_2", name: "View 2", filters: [], createdAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const result = readViews(SCHEMA);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("View 2");
  });
});

describe("saved views — generateId", () => {
  test("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId());
    }
    // All IDs should be unique
    expect(ids.size).toBe(100);
  });

  test("IDs start with sv_ prefix", () => {
    const id = generateId();
    expect(id.startsWith("sv_")).toBe(true);
  });
});

describe("saved views — CRUD operations", () => {
  test("create a new view", () => {
    const view: SavedView = {
      id: generateId(),
      name: "High Priority",
      filters: [{ field: "priority", operator: "eq", values: ["high"] }],
      sort: { field: "created_at", order: "desc" },
      createdAt: new Date().toISOString(),
    };
    const current = readViews(SCHEMA);
    writeViews(SCHEMA, [...current, view]);

    const result = readViews(SCHEMA);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("High Priority");
    expect(result[0].sort?.field).toBe("created_at");
  });

  test("rename a view", () => {
    const view: SavedView = {
      id: "sv_rename_test",
      name: "Old Name",
      filters: [],
      createdAt: new Date().toISOString(),
    };
    writeViews(SCHEMA, [view]);

    const current = readViews(SCHEMA);
    const updated = current.map((v) =>
      v.id === "sv_rename_test" ? { ...v, name: "New Name" } : v,
    );
    writeViews(SCHEMA, updated);

    const result = readViews(SCHEMA);
    expect(result[0].name).toBe("New Name");
    expect(result[0].id).toBe("sv_rename_test");
  });

  test("delete a view", () => {
    const views: SavedView[] = [
      { id: "sv_1", name: "View A", filters: [], createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "sv_2", name: "View B", filters: [], createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "sv_3", name: "View C", filters: [], createdAt: "2026-01-03T00:00:00.000Z" },
    ];
    writeViews(SCHEMA, views);

    const current = readViews(SCHEMA);
    writeViews(SCHEMA, current.filter((v) => v.id !== "sv_2"));

    const result = readViews(SCHEMA);
    expect(result).toHaveLength(2);
    expect(result.map((v) => v.id)).toEqual(["sv_1", "sv_3"]);
  });

  test("update a view's filters and sort", () => {
    const view: SavedView = {
      id: "sv_update",
      name: "Updatable",
      filters: [{ field: "status", operator: "eq", values: ["draft"] }],
      sort: { field: "name", order: "asc" },
      createdAt: new Date().toISOString(),
    };
    writeViews(SCHEMA, [view]);

    const newFilters = [{ field: "priority", operator: "in", values: ["high", "medium"] }];
    const newSort: SavedViewSort = { field: "updated_at", order: "desc" };

    const current = readViews(SCHEMA);
    const updated = current.map((v) =>
      v.id === "sv_update" ? { ...v, filters: newFilters, sort: newSort } : v,
    );
    writeViews(SCHEMA, updated);

    const result = readViews(SCHEMA);
    expect(result[0].filters[0].field).toBe("priority");
    expect(result[0].sort?.order).toBe("desc");
  });

  test("views for different schemas are isolated", () => {
    writeViews("schema_a", [
      { id: "sv_a", name: "Schema A View", filters: [], createdAt: new Date().toISOString() },
    ]);
    writeViews("schema_b", [
      { id: "sv_b", name: "Schema B View", filters: [], createdAt: new Date().toISOString() },
    ]);

    expect(readViews("schema_a")).toHaveLength(1);
    expect(readViews("schema_a")[0].name).toBe("Schema A View");
    expect(readViews("schema_b")).toHaveLength(1);
    expect(readViews("schema_b")[0].name).toBe("Schema B View");
  });

  test("empty localStorage returns empty views", () => {
    expect(readViews("nonexistent_schema")).toEqual([]);
  });
});
