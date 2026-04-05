import { describe, expect, test } from "bun:test";
import {
  buildTree,
  collectAllIds,
  filterTree,
  getSearchExpandIds,
  reparentRecord,
  wouldCreateCycle,
} from "../src/components/auto-tree/tree-utils";

describe("buildTree", () => {
  test("empty records produce empty tree", () => {
    expect(buildTree([], "parent_id")).toEqual([]);
  });

  test("all root nodes (no parent)", () => {
    const records = [
      { id: "1", name: "A", parent_id: null },
      { id: "2", name: "B", parent_id: null },
    ];
    const tree = buildTree(records, "parent_id");
    expect(tree).toHaveLength(2);
    expect(tree[0].record.name).toBe("A");
    expect(tree[1].record.name).toBe("B");
    expect(tree[0].children).toHaveLength(0);
  });

  test("builds parent-child hierarchy", () => {
    const records = [
      { id: "1", name: "Root", parent_id: null },
      { id: "2", name: "Child A", parent_id: "1" },
      { id: "3", name: "Child B", parent_id: "1" },
      { id: "4", name: "Grandchild", parent_id: "2" },
    ];
    const tree = buildTree(records, "parent_id");
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].record.name).toBe("Child A");
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].record.name).toBe("Grandchild");
    expect(tree[0].children[1].record.name).toBe("Child B");
    expect(tree[0].children[1].children).toHaveLength(0);
  });

  test("orphan nodes are promoted to root", () => {
    const records = [
      { id: "1", name: "Root", parent_id: null },
      { id: "2", name: "Orphan", parent_id: "999" },
    ];
    const tree = buildTree(records, "parent_id");
    expect(tree).toHaveLength(2);
    expect(tree[0].record.name).toBe("Root");
    expect(tree[1].record.name).toBe("Orphan");
  });

  test("handles undefined parent field as root", () => {
    const records = [
      { id: "1", name: "A" },
      { id: "2", name: "B", parent_id: undefined },
    ];
    const tree = buildTree(records, "parent_id");
    expect(tree).toHaveLength(2);
  });

  test("handles empty string parent field as root", () => {
    const records = [{ id: "1", name: "A", parent_id: "" }];
    const tree = buildTree(records, "parent_id");
    expect(tree).toHaveLength(1);
  });

  test("numeric ids work correctly", () => {
    const records = [
      { id: 1, name: "Root", parent_id: null },
      { id: 2, name: "Child", parent_id: 1 },
    ];
    const tree = buildTree(records, "parent_id");
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
  });

  test("deeply nested hierarchy", () => {
    const records = [
      { id: "1", name: "L0", parent_id: null },
      { id: "2", name: "L1", parent_id: "1" },
      { id: "3", name: "L2", parent_id: "2" },
      { id: "4", name: "L3", parent_id: "3" },
      { id: "5", name: "L4", parent_id: "4" },
    ];
    const tree = buildTree(records, "parent_id");
    expect(tree).toHaveLength(1);
    let node = tree[0];
    for (let i = 1; i <= 4; i++) {
      expect(node.children).toHaveLength(1);
      node = node.children[0];
      expect(node.record.name).toBe(`L${i}`);
    }
    expect(node.children).toHaveLength(0);
  });
});

describe("collectAllIds", () => {
  test("empty tree returns empty set", () => {
    expect(collectAllIds([])).toEqual(new Set());
  });

  test("only collects ids of nodes with children", () => {
    const records = [
      { id: "1", name: "Root", parent_id: null },
      { id: "2", name: "Child", parent_id: "1" },
      { id: "3", name: "Leaf", parent_id: null },
    ];
    const tree = buildTree(records, "parent_id");
    const ids = collectAllIds(tree);
    // Only "1" has children; "2" and "3" are leaves
    expect(ids).toEqual(new Set(["1"]));
  });

  test("collects all branch node ids in deep tree", () => {
    const records = [
      { id: "1", name: "L0", parent_id: null },
      { id: "2", name: "L1", parent_id: "1" },
      { id: "3", name: "L2", parent_id: "2" },
      { id: "4", name: "Leaf", parent_id: "3" },
    ];
    const tree = buildTree(records, "parent_id");
    const ids = collectAllIds(tree);
    expect(ids).toEqual(new Set(["1", "2", "3"]));
  });
});

describe("filterTree", () => {
  const records = [
    { id: "1", name: "Root", parent_id: null },
    { id: "2", name: "Child Alpha", parent_id: "1" },
    { id: "3", name: "Child Beta", parent_id: "1" },
    { id: "4", name: "Grandchild Alpha One", parent_id: "2" },
    { id: "5", name: "Other Root", parent_id: null },
  ];

  test("empty query returns original tree", () => {
    const tree = buildTree(records, "parent_id");
    const result = filterTree(tree, "", "name");
    expect(result).toHaveLength(2);
  });

  test("matches direct nodes by label", () => {
    const tree = buildTree(records, "parent_id");
    const result = filterTree(tree, "Beta", "name");
    expect(result).toHaveLength(1);
    expect(result[0].record.name).toBe("Root");
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].record.name).toBe("Child Beta");
  });

  test("preserves ancestor chain for matching descendants", () => {
    const tree = buildTree(records, "parent_id");
    const result = filterTree(tree, "Grandchild", "name");
    expect(result).toHaveLength(1);
    expect(result[0].record.name).toBe("Root");
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].record.name).toBe("Child Alpha");
    expect(result[0].children[0].children).toHaveLength(1);
    expect(result[0].children[0].children[0].record.name).toBe("Grandchild Alpha One");
  });

  test("case-insensitive matching", () => {
    const tree = buildTree(records, "parent_id");
    const result = filterTree(tree, "alpha", "name");
    // "Child Alpha" and "Grandchild Alpha One" match — Root ancestor included
    expect(result).toHaveLength(1);
    expect(result[0].record.name).toBe("Root");
  });

  test("no matches returns empty array", () => {
    const tree = buildTree(records, "parent_id");
    const result = filterTree(tree, "zzz-no-match", "name");
    expect(result).toHaveLength(0);
  });
});

describe("getSearchExpandIds", () => {
  test("empty query returns empty set", () => {
    const tree = buildTree([], "parent_id");
    expect(getSearchExpandIds(tree, "", "name")).toEqual(new Set());
  });

  test("returns ancestor ids when descendants match", () => {
    const records = [
      { id: "1", name: "Root", parent_id: null },
      { id: "2", name: "Parent", parent_id: "1" },
      { id: "3", name: "Target", parent_id: "2" },
    ];
    const tree = buildTree(records, "parent_id");
    const ids = getSearchExpandIds(tree, "Target", "name");
    expect(ids.has("1")).toBe(true);
    expect(ids.has("2")).toBe(true);
    expect(ids.has("3")).toBe(false); // leaf, not an ancestor
  });
});

describe("reparentRecord", () => {
  test("updates parent field for target record", () => {
    const records = [
      { id: "1", name: "A", parent_id: null },
      { id: "2", name: "B", parent_id: "1" },
    ];
    const result = reparentRecord(records, "2", null, "parent_id");
    const updated = result.find((r) => String(r.id) === "2");
    expect(updated?.parent_id).toBe(null);
  });

  test("returns new array (immutable)", () => {
    const records = [{ id: "1", name: "A", parent_id: null }];
    const result = reparentRecord(records, "1", "2", "parent_id");
    expect(result).not.toBe(records);
    expect(result[0]).not.toBe(records[0]);
  });
});

describe("wouldCreateCycle", () => {
  const records = [
    { id: "1", name: "Root", parent_id: null },
    { id: "2", name: "Child", parent_id: "1" },
    { id: "3", name: "Grandchild", parent_id: "2" },
  ];

  test("moving to own descendant is a cycle", () => {
    expect(wouldCreateCycle(records, "1", "3", "parent_id")).toBe(true);
  });

  test("moving to self is a cycle", () => {
    expect(wouldCreateCycle(records, "1", "1", "parent_id")).toBe(true);
  });

  test("moving to root (null) is not a cycle", () => {
    expect(wouldCreateCycle(records, "3", null, "parent_id")).toBe(false);
  });

  test("moving to sibling is not a cycle", () => {
    const r = [
      { id: "1", name: "Root", parent_id: null },
      { id: "2", name: "A", parent_id: "1" },
      { id: "3", name: "B", parent_id: "1" },
    ];
    expect(wouldCreateCycle(r, "2", "3", "parent_id")).toBe(false);
  });
});
