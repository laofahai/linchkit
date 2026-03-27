/**
 * Action Registry
 *
 * Manages registration and lookup of action definitions.
 * Extracted from action-engine.ts for maintainability.
 */

import type { ActionDefinition } from "../types/action";

export class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  /** Register an action definition. Throws on duplicate name unless overwrite is set. */
  register(action: ActionDefinition, opts?: { overwrite?: boolean }): void {
    if (!action.name) {
      throw new Error("Action must have a name");
    }
    if (this.actions.has(action.name) && !opts?.overwrite) {
      throw new Error(`Action "${action.name}" is already registered`);
    }
    this.actions.set(action.name, action);
  }

  /** Get an action by name, or undefined if not found */
  get(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  /** Get all registered actions */
  getAll(): ActionDefinition[] {
    return Array.from(this.actions.values());
  }

  /** Get all actions for a given schema (own only, no inheritance) */
  getBySchema(schema: string): ActionDefinition[] {
    return this.getAll().filter((a) => a.schema === schema);
  }

  /**
   * Get all actions for a schema including actions inherited from ancestor schemas.
   * Child actions override parent actions of the same name.
   * @param schema - The schema name
   * @param inheritanceChain - Ordered from root ancestor to self (e.g., ['party', 'customer'])
   */
  getBySchemaWithInheritance(schema: string, inheritanceChain: string[]): ActionDefinition[] {
    const ownActions = this.getBySchema(schema);
    const ownNames = new Set(ownActions.map((a) => a.name));

    // Collect inherited actions from ancestors (excluding self, which is last in chain)
    const inherited: ActionDefinition[] = [];
    for (let i = 0; i < inheritanceChain.length - 1; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index is within bounds
      for (const action of this.getBySchema(inheritanceChain[i]!)) {
        // Only include if not overridden by a closer descendant or self
        if (!ownNames.has(action.name) && !inherited.some((a) => a.name === action.name)) {
          inherited.push(action);
        }
      }
    }

    return [...inherited, ...ownActions];
  }

  /** Check if an action is registered */
  has(name: string): boolean {
    return this.actions.has(name);
  }
}
