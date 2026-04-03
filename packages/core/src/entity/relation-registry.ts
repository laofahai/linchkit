/**
 * Link Registry
 *
 * Manages link definitions between schemas.
 * Provides directional queries (outgoing, incoming, both) and lookup by endpoints.
 */

import type { RelationDefinition, LinkInfo, RelationRegistryInterface } from "../types/relation";

// ── RelationRegistry ──────────────────────────────────────────────

export class RelationRegistry implements RelationRegistryInterface {
  private links = new Map<string, RelationDefinition>();

  /**
   * Register a link definition.
   * Throws if a link with the same name is already registered.
   */
  register(link: RelationDefinition): void {
    if (this.links.has(link.name)) {
      throw new Error(`Link "${link.name}" is already registered`);
    }
    this.links.set(link.name, link);
  }

  /**
   * Get all links for a schema (both outgoing and incoming) as LinkInfo[].
   */
  relationsFor(schemaName: string): LinkInfo[] {
    const result: LinkInfo[] = [];

    for (const link of this.links.values()) {
      if (link.from === schemaName) {
        result.push({
          link,
          direction: "outgoing",
          relatedSchema: link.to,
          label: link.label?.from ?? link.to,
        });
      }
      if (link.to === schemaName) {
        result.push({
          link,
          direction: "incoming",
          relatedSchema: link.from,
          label: link.label?.to ?? link.from,
        });
      }
    }

    return result;
  }

  /**
   * Get the first link matching from → to (if any).
   */
  linkBetween(from: string, to: string): RelationDefinition | null {
    for (const link of this.links.values()) {
      if (link.from === from && link.to === to) {
        return link;
      }
    }
    return null;
  }

  /** Get all outgoing links from a schema */
  outgoingRelations(schemaName: string): RelationDefinition[] {
    const result: RelationDefinition[] = [];
    for (const link of this.links.values()) {
      if (link.from === schemaName) {
        result.push(link);
      }
    }
    return result;
  }

  /** Get all incoming links to a schema */
  incomingRelations(schemaName: string): RelationDefinition[] {
    const result: RelationDefinition[] = [];
    for (const link of this.links.values()) {
      if (link.to === schemaName) {
        result.push(link);
      }
    }
    return result;
  }

  /** List all registered links */
  list(): RelationDefinition[] {
    return Array.from(this.links.values());
  }
}

// ── Factory ─────────────────────────────────────────────────────

/** Create a new RelationRegistry instance */
export function createRelationRegistry(): RelationRegistry {
  return new RelationRegistry();
}
