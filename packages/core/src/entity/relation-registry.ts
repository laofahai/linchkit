/**
 * Relation Registry — Spec 61: Semantic Relation Unification
 *
 * Manages relation definitions between entities with semantic navigation names.
 * Provides directional queries (outgoing, incoming, both), semantic name lookup,
 * and multi-relation support between the same entity pair.
 */

import type {
  RelationDefinition,
  RelationInfo,
  RelationRegistryInterface,
} from "../types/relation";

// ── RelationRegistry ──────────────────────────────────────────────

export class RelationRegistry implements RelationRegistryInterface {
  private relations = new Map<string, RelationDefinition>();

  /**
   * Register a relation definition.
   * Throws if a relation with the same name is already registered,
   * or if semantic names conflict on the same entity.
   */
  register(relation: RelationDefinition): void {
    if (this.relations.has(relation.name)) {
      throw new Error(`Relation "${relation.name}" is already registered`);
    }

    // Validate semantic name uniqueness per entity
    for (const existing of this.relations.values()) {
      // Check fromName conflicts on the 'from' entity
      if (existing.from === relation.from && existing.fromName === relation.fromName) {
        throw new Error(
          `Entity "${relation.from}" has duplicate semantic name "${relation.fromName}" from relations "${existing.name}" and "${relation.name}"`,
        );
      }
      // Check toName conflicts on the 'to' entity
      if (existing.to === relation.to && existing.toName === relation.toName) {
        throw new Error(
          `Entity "${relation.to}" has duplicate semantic name "${relation.toName}" from relations "${existing.name}" and "${relation.name}"`,
        );
      }
      // Check cross-direction conflicts (fromName on 'from' vs toName on same entity from another relation)
      if (existing.to === relation.from && existing.toName === relation.fromName) {
        throw new Error(
          `Entity "${relation.from}" has duplicate semantic name "${relation.fromName}" from relations "${existing.name}" (toName) and "${relation.name}" (fromName)`,
        );
      }
      if (existing.from === relation.to && existing.fromName === relation.toName) {
        throw new Error(
          `Entity "${relation.to}" has duplicate semantic name "${relation.toName}" from relations "${existing.name}" (fromName) and "${relation.name}" (toName)`,
        );
      }
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
          semanticName: relation.fromName,
          label: relation.label?.from ?? relation.fromName,
        });
      }
      if (relation.to === entityName) {
        result.push({
          relation,
          direction: "incoming",
          relatedEntity: relation.from,
          semanticName: relation.toName,
          label: relation.label?.to ?? relation.toName,
        });
      }
    }

    return result;
  }

  /**
   * Get all relations between two entities (may return multiple).
   */
  relationsBetween(from: string, to: string): RelationDefinition[] {
    const result: RelationDefinition[] = [];
    for (const relation of this.relations.values()) {
      if (relation.from === from && relation.to === to) {
        result.push(relation);
      }
    }
    return result;
  }

  /**
   * Find a relation by semantic name on an entity.
   * Searches both fromName (outgoing) and toName (incoming).
   */
  relationByName(entityName: string, semanticName: string): RelationInfo | null {
    for (const relation of this.relations.values()) {
      if (relation.from === entityName && relation.fromName === semanticName) {
        return {
          relation,
          direction: "outgoing",
          relatedEntity: relation.to,
          semanticName: relation.fromName,
          label: relation.label?.from ?? relation.fromName,
        };
      }
      if (relation.to === entityName && relation.toName === semanticName) {
        return {
          relation,
          direction: "incoming",
          relatedEntity: relation.from,
          semanticName: relation.toName,
          label: relation.label?.to ?? relation.toName,
        };
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
