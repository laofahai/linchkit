/**
 * Utility functions for converting flat record lists into tree structures.
 */

/** A tree node wrapping a flat record with computed children. */
export interface TreeNode {
  record: Record<string, unknown>;
  children: TreeNode[];
}

/**
 * Build a tree from a flat list of records.
 *
 * - Records whose parentField is null/undefined/empty become root nodes.
 * - Orphan records (parentField points to a non-existent id) are promoted to root.
 *
 * @param records  Flat list of records (each must have `id` and the parent field)
 * @param parentField  The field name referencing the parent record id (e.g. "parent_id")
 * @returns  Array of root TreeNodes
 */
export function buildTree(
  records: Record<string, unknown>[],
  parentField: string,
): TreeNode[] {
  // Index all records by id
  const byId = new Map<string, TreeNode>();
  for (const record of records) {
    byId.set(String(record.id), { record, children: [] });
  }

  const roots: TreeNode[] = [];

  for (const record of records) {
    const parentId = record[parentField];
    const node = byId.get(String(record.id));
    if (!node) continue;

    if (parentId == null || parentId === "" || parentId === undefined) {
      // Root node
      roots.push(node);
    } else {
      const parent = byId.get(String(parentId));
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphan — promote to root
        roots.push(node);
      }
    }
  }

  return roots;
}

/**
 * Collect all node ids in a tree (for expand-all / collapse-all).
 */
export function collectAllIds(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const id = String(node.record.id);
    if (node.children.length > 0) {
      ids.add(id);
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return ids;
}
