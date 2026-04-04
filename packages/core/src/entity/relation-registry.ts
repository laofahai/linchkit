/**
 * Relation Registry
 *
 * Manages relation definitions between entities.
 * Provides directional queries (outgoing, incoming, both) and lookup by endpoints.
 */

import type { RelationDefinition, RelationInfo, RelationRegistryInterface } from "../types/relation";

// ── RelationRegistry ──────────────────────────────────────────────

export class RelationRegistry implements RelationRegistryInterface {
  private relations = new Map<string, RelationDefinition>();

  /**
   * Register a relation definition.
   * Throws if a relation with the same name is already registered.
   */
  register(relation: RelationDefinition): void {
    if (this.relations.has(relation.name)) {
      throw new Error(`Relation "${relation.name}" is already registered`);
    }
    this.relations.set(relation.name, relation);
  }

  /**
   * Get all relations for an entity (both outgoing and incoming) as RelationInfo[].
   */
  relationsFor(entityName: string): RelationInfo[] {
    const result: RelationInfo[] = [];

    for (const relation of this.relations.values()) {
      if (relation.from === entityName) {
        result.push({
          relation,
          direction: "outgoing",
          relatedEntity: relation.to,
          label: relation.label?.from ?? relation.to,
        });
      }
      if (relation.to === entityName) {
        result.push({
          relation,
          direction: "incoming",
          relatedEntity: relation.from,
          label: relation.label?.to ?? relation.from,
        });
      }
    }

    return result;
  }

  /**
   * Get the first relation matching from → to (if any).
   */
  relationBetween(from: string, to: string): RelationDefinition | null {
    for (const relation of this.relations.values()) {
      if (relation.from === from && relation.to === to) {
        return relation;
      }
    }
    return null;
  }

  /** Get all outgoing relations from an entity */
  outgoingRelations(entityName: string): RelationDefinition[] {
    const result: RelationDefinition[] = [];
    for (const relation of this.relations.values()) {
      if (relation.from === entityName) {
        result.push(relation);
      }
    }
    return result;
  }

  /** Get all incoming relations to an entity */
  incomingRelations(entityName: string): RelationDefinition[] {
    const result: RelationDefinition[] = [];
    for (const relation of this.relations.values()) {
      if (relation.to === entityName) {
        result.push(relation);
      }
    }
    return result;
  }

  /** List all registered relations */
  list(): RelationDefinition[] {
    return Array.from(this.relations.values());
  }
}

// ── Factory ─────────────────────────────────────────────────────

/** Create a new RelationRegistry instance */
export function createRelationRegistry(): RelationRegistry {
  return new RelationRegistry();
}
