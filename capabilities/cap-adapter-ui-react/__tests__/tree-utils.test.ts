import { describe, expect, test } from "bun:test";
import { buildTree, collectAllIds } from "../src/components/auto-tree/tree-utils";

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
    const records = [
      { id: "1", name: "A", parent_id: "" },
    ];
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
