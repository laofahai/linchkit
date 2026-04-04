/**
 * Documentation Search Engine
 *
 * Provides full-text search across capability documentation including
 * schemas, actions, rules, state machines, views, and relations.
 *
 * Used by:
 * - CLI: `linch docs search "keyword"`
 * - MCP: `get_capability_docs` tool
 *
 * See spec: docs/specs/25_documentation.md §5, §6 (M2)
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { type CapabilitySpecDoc, generateCapabilityDoc } from "./capability-doc-generator";

// -- Search result types -------------------------------------------------

/** A search result entry */
export interface DocSearchResult {
  /** Type of the matched element */
  type: "capability" | "schema" | "action" | "rule" | "state_machine" | "view" | "relation";
  /** Name of the matched element */
  name: string;
  /** Which capability it belongs to */
  capability: string;
  /** Label for display */
  label: string;
  /** Description or context */
  description?: string;
  /** Relevance score (higher = more relevant) */
  score: number;
}

/** Options for doc search */
export interface DocSearchOptions {
  /** Limit the number of results (default: 20) */
  limit?: number;
  /** Filter by element type */
  type?: DocSearchResult["type"];
  /** Filter by capability name */
  capability?: string;
}

// -- Search index -------------------------------------------------

/** Internal index entry for search */
interface SearchEntry {
  type: DocSearchResult["type"];
  name: string;
  capability: string;
  label: string;
  description?: string;
  /** Combined searchable text (lowercased) */
  searchText: string;
}

/**
 * Documentation search index built from CapabilityDefinitions.
 *
 * Indexes all documentable elements (schemas, actions, rules, etc.)
 * and provides keyword search with relevance scoring.
 */
export class DocSearchIndex {
  private entries: SearchEntry[] = [];

  /** Add a capability and all its elements to the search index */
  addCapability(cap: CapabilityDefinition): void {
    const doc = generateCapabilityDoc(cap);
    this.indexCapabilityDoc(doc);
  }

  /** Add multiple capabilities to the search index */
  addCapabilities(caps: CapabilityDefinition[]): void {
    for (const cap of caps) {
      this.addCapability(cap);
    }
  }

  /** Index a pre-generated CapabilitySpecDoc */
  indexCapabilityDoc(doc: CapabilitySpecDoc): void {
    // Index the capability itself
    this.entries.push({
      type: "capability",
      name: doc.name,
      capability: doc.name,
      label: doc.label,
      description: doc.description,
      searchText: [doc.name, doc.label, doc.description ?? "", doc.type, doc.category]
        .join(" ")
        .toLowerCase(),
    });

    // Index schemas
    for (const schema of doc.schemas) {
      const fieldNames = schema.fields.map((f) => `${f.name} ${f.label}`).join(" ");
      this.entries.push({
        type: "schema",
        name: schema.name,
        capability: doc.name,
        label: schema.label ?? schema.name,
        description: schema.description,
        searchText: [schema.name, schema.label ?? "", schema.description ?? "", fieldNames]
          .join(" ")
          .toLowerCase(),
      });
    }

    // Index actions
    for (const action of doc.actions) {
      this.entries.push({
        type: "action",
        name: action.name,
        capability: doc.name,
        label: action.label,
        description: action.description,
        searchText: [action.name, action.label, action.description ?? "", action.schema]
          .join(" ")
          .toLowerCase(),
      });
    }

    // Index rules
    for (const rule of doc.rules) {
      this.entries.push({
        type: "rule",
        name: rule.name,
        capability: doc.name,
        label: rule.label,
        description: rule.description,
        searchText: [rule.name, rule.label, rule.description ?? ""].join(" ").toLowerCase(),
      });
    }

    // Index state machines
    for (const sm of doc.stateMachines) {
      this.entries.push({
        type: "state_machine",
        name: sm.name,
        capability: doc.name,
        label: sm.name,
        description: `${sm.schema}: ${sm.states.join(" -> ")}`,
        searchText: [sm.name, sm.schema, ...sm.states, sm.initial].join(" ").toLowerCase(),
      });
    }

    // Index views
    for (const view of doc.views) {
      this.entries.push({
        type: "view",
        name: view.name,
        capability: doc.name,
        label: view.label ?? view.name,
        description: `${view.type} view for ${view.schema}`,
        searchText: [view.name, view.label ?? "", view.schema, view.type].join(" ").toLowerCase(),
      });
    }

    // Index relations
    for (const rel of doc.relations) {
      this.entries.push({
        type: "relation",
        name: rel.relationName,
        capability: doc.name,
        label: rel.relationName,
        description: `${rel.from} -> ${rel.to} (${rel.cardinality})`,
        searchText: [rel.relationName, rel.from, rel.to, rel.cardinality].join(" ").toLowerCase(),
      });
    }
  }

  /**
   * Search the documentation index by keyword.
   *
   * Scoring:
   * - Exact name match: +10
   * - Name contains query: +5
   * - Label contains query: +3
   * - Description/searchText contains query: +1
   *
   * Results are sorted by score (descending), then by name.
   */
  search(query: string, options?: DocSearchOptions): DocSearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const limit = options?.limit ?? 20;
    const words = q.split(/\s+/);

    let results: DocSearchResult[] = [];

    for (const entry of this.entries) {
      // Apply type filter
      if (options?.type && entry.type !== options.type) continue;
      // Apply capability filter
      if (options?.capability && entry.capability !== options.capability) continue;

      let score = 0;

      // Score based on match quality
      for (const word of words) {
        if (entry.name === word) {
          score += 10;
        } else if (entry.name.includes(word)) {
          score += 5;
        }

        if (entry.label.toLowerCase().includes(word)) {
          score += 3;
        }

        if (entry.searchText.includes(word)) {
          score += 1;
        }
      }

      if (score > 0) {
        results.push({
          type: entry.type,
          name: entry.name,
          capability: entry.capability,
          label: entry.label,
          description: entry.description,
          score,
        });
      }
    }

    // Sort by score descending, then by name alphabetically
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });

    // Apply limit
    if (results.length > limit) {
      results = results.slice(0, limit);
    }

    return results;
  }

  /** Get total number of indexed entries */
  get size(): number {
    return this.entries.length;
  }

  /** Clear the index */
  clear(): void {
    this.entries = [];
  }
}

/**
 * Create a DocSearchIndex from an array of CapabilityDefinitions.
 *
 * Convenience factory that builds and populates the index in one call.
 */
export function createDocSearchIndex(capabilities: CapabilityDefinition[]): DocSearchIndex {
  const index = new DocSearchIndex();
  index.addCapabilities(capabilities);
  return index;
}
