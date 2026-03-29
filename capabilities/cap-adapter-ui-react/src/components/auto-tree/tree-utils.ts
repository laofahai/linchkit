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
export function buildTree(records: Record<string, unknown>[], parentField: string): TreeNode[] {
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
    const node = stack.pop();
    if (!node) break;
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

/**
 * Filter a tree by a search query string.
 *
 * A node matches if its label contains the query (case-insensitive).
 * Ancestor nodes of matching nodes are always included to preserve the chain.
 * Returns a new tree containing only matching nodes and their ancestors.
 *
 * @param nodes       Tree nodes to filter
 * @param query       Search string (empty string returns original tree)
 * @param labelField  Field name used as the node label
 * @returns  Filtered tree preserving ancestor chain
 */
export function filterTree(nodes: TreeNode[], query: string, labelField: string): TreeNode[] {
  if (!query.trim()) return nodes;

  const lowerQuery = query.toLowerCase();

  function filterNode(node: TreeNode): TreeNode | null {
    const label = String(node.record[labelField] ?? node.record.name ?? node.record.id ?? "");
    const selfMatches = label.toLowerCase().includes(lowerQuery);

    // Recursively filter children
    const filteredChildren = node.children.map(filterNode).filter((n): n is TreeNode => n !== null);

    if (selfMatches || filteredChildren.length > 0) {
      return { record: node.record, children: filteredChildren };
    }
    return null;
  }

  return nodes.map(filterNode).filter((n): n is TreeNode => n !== null);
}

/**
 * Collect ids of all nodes that should be expanded when a search query is active.
 * Expands all ancestor nodes of matching nodes so they are visible.
 */
export function getSearchExpandIds(nodes: TreeNode[], query: string, labelField: string): Set<string> {
  if (!query.trim()) return new Set();

  const lowerQuery = query.toLowerCase();
  const ids = new Set<string>();

  function walk(node: TreeNode): boolean {
    const label = String(node.record[labelField] ?? node.record.name ?? node.record.id ?? "");
    const selfMatches = label.toLowerCase().includes(lowerQuery);

    let childMatches = false;
    for (const child of node.children) {
      if (walk(child)) {
        childMatches = true;
      }
    }

    // If any descendant matches, expand this node
    if (childMatches) {
      ids.add(String(node.record.id));
    }

    return selfMatches || childMatches;
  }

  for (const node of nodes) {
    walk(node);
  }
  return ids;
}

/**
 * Reparent a record in a flat list: update its parentField to newParentId.
 * Returns the modified records array (immutable — creates new objects).
 */
export function reparentRecord(
  records: Record<string, unknown>[],
  draggedId: string,
  newParentId: string | null,
  parentField: string,
): Record<string, unknown>[] {
  return records.map((r) => {
    if (String(r.id) === draggedId) {
      return { ...r, [parentField]: newParentId };
    }
    return r;
  });
}

/**
 * Check if making `candidateId` a child of `newParentId` would create a cycle.
 * Returns true if it would (i.e., newParentId is a descendant of candidateId).
 */
export function wouldCreateCycle(
  records: Record<string, unknown>[],
  draggedId: string,
  newParentId: string | null,
  parentField: string,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === draggedId) return true;

  // Walk up from newParentId — if we encounter draggedId, it's a cycle
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of records) {
    byId.set(String(r.id), r);
  }

  let current: string | null = newParentId;
  const visited = new Set<string>();
  while (current !== null) {
    if (current === draggedId) return true;
    if (visited.has(current)) break; // defensive cycle break
    visited.add(current);
    const rec = byId.get(current);
    if (!rec) break;
    const parentId = rec[parentField];
    current = parentId == null || parentId === "" ? null : String(parentId);
  }
  return false;
}
