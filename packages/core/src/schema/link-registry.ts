/**
 * Link Registry
 *
 * Manages link definitions between schemas.
 * Provides directional queries (outgoing, incoming, both) and lookup by endpoints.
 */

import type { LinkDefinition, LinkInfo, LinkRegistryInterface } from "../types/link";

// ── LinkRegistry ──────────────────────────────────────────────

export class LinkRegistry implements LinkRegistryInterface {
  private links = new Map<string, LinkDefinition>();

  /**
   * Register a link definition.
   * Throws if a link with the same name is already registered.
   */
  register(link: LinkDefinition): void {
    if (this.links.has(link.name)) {
      throw new Error(`Link "${link.name}" is already registered`);
    }
    this.links.set(link.name, link);
  }

  /**
   * Get all links for a schema (both outgoing and incoming) as LinkInfo[].
   */
  linksFor(schemaName: string): LinkInfo[] {
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
  linkBetween(from: string, to: string): LinkDefinition | null {
    for (const link of this.links.values()) {
      if (link.from === from && link.to === to) {
        return link;
      }
    }
    return null;
  }

  /** Get all outgoing links from a schema */
  outgoingLinks(schemaName: string): LinkDefinition[] {
    const result: LinkDefinition[] = [];
    for (const link of this.links.values()) {
      if (link.from === schemaName) {
        result.push(link);
      }
    }
    return result;
  }

  /** Get all incoming links to a schema */
  incomingLinks(schemaName: string): LinkDefinition[] {
    const result: LinkDefinition[] = [];
    for (const link of this.links.values()) {
      if (link.to === schemaName) {
        result.push(link);
      }
    }
    return result;
  }

  /** List all registered links */
  list(): LinkDefinition[] {
    return Array.from(this.links.values());
  }
}

// ── Factory ─────────────────────────────────────────────────────

/** Create a new LinkRegistry instance */
export function createLinkRegistry(): LinkRegistry {
  return new LinkRegistry();
}
