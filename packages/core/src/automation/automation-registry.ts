/**
 * Automation Registry
 *
 * Stores and manages AutomationDefinition instances.
 * Thread-safe in-memory registry with enable/disable support.
 */

import type { AutomationDefinition } from "../types/automation";

export interface AutomationRegistry {
  /** Register an automation. Throws if name already exists. */
  register(automation: AutomationDefinition): void;

  /** Get an automation by name */
  get(name: string): AutomationDefinition | undefined;

  /** Get all registered automations */
  getAll(): AutomationDefinition[];

  /** Get only enabled automations */
  getEnabled(): AutomationDefinition[];

  /** Check if an automation exists */
  has(name: string): boolean;

  /** Enable an automation by name */
  enable(name: string): void;

  /** Disable an automation by name */
  disable(name: string): void;

  /** Remove an automation by name */
  remove(name: string): boolean;
}

class AutomationRegistryImpl implements AutomationRegistry {
  private automations = new Map<string, AutomationDefinition>();

  register(automation: AutomationDefinition): void {
    if (!automation.name) {
      throw new Error("AutomationDefinition must have a name");
    }
    if (this.automations.has(automation.name)) {
      throw new Error(`Automation "${automation.name}" is already registered`);
    }
    this.automations.set(automation.name, { ...automation });
  }

  get(name: string): AutomationDefinition | undefined {
    const a = this.automations.get(name);
    return a ? { ...a } : undefined;
  }

  getAll(): AutomationDefinition[] {
    return Array.from(this.automations.values()).map((a) => ({ ...a }));
  }

  getEnabled(): AutomationDefinition[] {
    return this.getAll().filter((a) => a.enabled);
  }

  has(name: string): boolean {
    return this.automations.has(name);
  }

  enable(name: string): void {
    const a = this.automations.get(name);
    if (!a) {
      throw new Error(`Automation "${name}" not found`);
    }
    a.enabled = true;
  }

  disable(name: string): void {
    const a = this.automations.get(name);
    if (!a) {
      throw new Error(`Automation "${name}" not found`);
    }
    a.enabled = false;
  }

  remove(name: string): boolean {
    return this.automations.delete(name);
  }
}

/** Create a new AutomationRegistry */
export function createAutomationRegistry(): AutomationRegistry {
  return new AutomationRegistryImpl();
}
