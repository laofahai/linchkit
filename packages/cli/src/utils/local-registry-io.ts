/**
 * Local registry file I/O — read/write capability-registry.json
 *
 * The registry file lives at `.linchkit/capability-registry.json` in the
 * project root. It tracks which capabilities are installed, their metadata,
 * trust level, and dependency relationships.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RegistryEntry } from "@linchkit/core";
import { LocalCapabilityRegistry } from "@linchkit/core";

const REGISTRY_DIR = ".linchkit";
const REGISTRY_FILE = "capability-registry.json";

/**
 * Resolve the registry file path relative to the given project root.
 */
export function registryFilePath(projectRoot: string): string {
  return resolve(projectRoot, REGISTRY_DIR, REGISTRY_FILE);
}

/**
 * Load the local registry from disk.
 * Returns an empty registry if the file does not exist.
 */
export function loadLocalRegistry(projectRoot: string): LocalCapabilityRegistry {
  const filePath = registryFilePath(projectRoot);
  if (!existsSync(filePath)) {
    return new LocalCapabilityRegistry();
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    return LocalCapabilityRegistry.fromJSON(data);
  } catch {
    // Corrupted or unreadable registry file — start fresh with empty registry
    return new LocalCapabilityRegistry();
  }
}

/**
 * Save the local registry to disk.
 * Creates the .linchkit directory if needed.
 */
export function saveLocalRegistry(projectRoot: string, registry: LocalCapabilityRegistry): void {
  const dir = resolve(projectRoot, REGISTRY_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const _filePath = registryFilePath(dir.replace(`/${REGISTRY_DIR}`, ""));
  // Re-compute proper path
  const actualPath = resolve(projectRoot, REGISTRY_DIR, REGISTRY_FILE);
  writeFileSync(actualPath, `${JSON.stringify(registry.toJSON(), null, 2)}\n`);
}

/**
 * Add or update a capability entry in the local registry and save.
 */
export function registerCapability(projectRoot: string, entry: RegistryEntry): void {
  const registry = loadLocalRegistry(projectRoot);
  registry.register(entry);
  saveLocalRegistry(projectRoot, registry);
}

/**
 * Remove a capability from the local registry and save.
 */
export function unregisterCapability(projectRoot: string, name: string): boolean {
  const registry = loadLocalRegistry(projectRoot);
  const removed = registry.unregister(name);
  if (removed) {
    saveLocalRegistry(projectRoot, registry);
  }
  return removed;
}
