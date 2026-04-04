/**
 * Watcher Registry
 *
 * Stores and manages WatcherDefinition instances.
 * Provides lookup by schema for efficient post-mutation evaluation.
 */

import type { WatcherDefinition } from "../types/watcher";

export interface WatcherRegistry {
  /** Register a watcher. Throws if name already exists. */
  register(watcher: WatcherDefinition): void;

  /** Get a watcher by name */
  get(name: string): WatcherDefinition | undefined;

  /** Get all registered watchers */
  getAll(): WatcherDefinition[];

  /** Get only enabled watchers */
  getEnabled(): WatcherDefinition[];

  /** Get enabled watchers that watch a specific schema */
  getForEntity(schemaName: string): WatcherDefinition[];

  /** Check if a watcher exists */
  has(name: string): boolean;

  /** Enable a watcher by name */
  enable(name: string): void;

  /** Disable a watcher by name */
  disable(name: string): void;

  /** Remove a watcher by name */
  remove(name: string): boolean;
}

class WatcherRegistryImpl implements WatcherRegistry {
  private watchers = new Map<string, WatcherDefinition>();

  register(watcher: WatcherDefinition): void {
    if (!watcher.name) {
      throw new Error("WatcherDefinition must have a name");
    }
    if (this.watchers.has(watcher.name)) {
      throw new Error(`Watcher "${watcher.name}" is already registered`);
    }
    this.watchers.set(watcher.name, { ...watcher });
  }

  get(name: string): WatcherDefinition | undefined {
    const w = this.watchers.get(name);
    return w ? { ...w } : undefined;
  }

  getAll(): WatcherDefinition[] {
    return Array.from(this.watchers.values()).map((w) => ({ ...w }));
  }

  getEnabled(): WatcherDefinition[] {
    return this.getAll().filter((w) => w.enabled);
  }

  getForEntity(schemaName: string): WatcherDefinition[] {
    return this.getEnabled().filter((w) => w.watch.entity === schemaName);
  }

  has(name: string): boolean {
    return this.watchers.has(name);
  }

  enable(name: string): void {
    const w = this.watchers.get(name);
    if (!w) {
      throw new Error(`Watcher "${name}" not found`);
    }
    w.enabled = true;
  }

  disable(name: string): void {
    const w = this.watchers.get(name);
    if (!w) {
      throw new Error(`Watcher "${name}" not found`);
    }
    w.enabled = false;
  }

  remove(name: string): boolean {
    return this.watchers.delete(name);
  }
}

/** Create a new WatcherRegistry */
export function createWatcherRegistry(): WatcherRegistry {
  return new WatcherRegistryImpl();
}
