/**
 * cap-file-storage capability definition + factory.
 *
 * Provides:
 * - `file` entity (metadata for stored files)
 * - Actions: upload_file, download_file, delete_file
 * - A pluggable StorageAdapter contract, with a LocalStorageAdapter reference impl
 *
 * The factory wires the supplied adapter into the module-level storage registry
 * that the actions read from. A follow-up PR will add a `file` field type and
 * an S3/cloud adapter (see TODOs).
 */

import { type CapabilityDefinition, defineCapability } from "@linchkit/core";
import { deleteFileAction } from "./actions/delete_file";
import { downloadFileAction } from "./actions/download_file";
import { uploadFileAction } from "./actions/upload_file";
import { LocalStorageAdapter } from "./adapters/local-adapter";
import type { StorageAdapter } from "./adapters/storage-adapter";
import { fileEntity } from "./entities/file";
import { setStorageAdapter } from "./storage-registry";

export interface CapFileStorageOptions {
  /**
   * Pre-built StorageAdapter. When omitted, a LocalStorageAdapter is created
   * at `rootDir` (defaults to `./.data/files`).
   */
  adapter?: StorageAdapter;
  /** Root directory for the default LocalStorageAdapter (ignored if `adapter` is provided) */
  rootDir?: string;
}

/**
 * Create a fully-wired cap-file-storage capability.
 *
 * @example
 * ```ts
 * import { createCapFileStorage } from "@linchkit/cap-file-storage"
 * const capFileStorage = createCapFileStorage({ rootDir: "./.data/files" })
 * ```
 */
export function createCapFileStorage(
  options?: CapFileStorageOptions,
): CapabilityDefinition & { adapter: StorageAdapter } {
  const adapter: StorageAdapter =
    options?.adapter ?? new LocalStorageAdapter({ rootDir: options?.rootDir ?? "./.data/files" });

  setStorageAdapter(adapter);

  const capability = defineCapability({
    name: "cap-file-storage",
    label: "File Storage",
    description:
      "File storage capability — file metadata entity, pluggable StorageAdapter " +
      "(local implementation included), and upload/download/delete actions.",
    type: "standard",
    category: "system",
    version: "0.0.1",
    group: "file-storage",

    entities: [fileEntity],
    actions: [uploadFileAction, downloadFileAction, deleteFileAction],

    extensions: {
      services: [
        {
          name: "storage",
          factory: () => adapter,
        },
      ],
    },

    systemPermissions: ["database.read", "database.write", "event.emit"],
  });

  return Object.assign(capability, { adapter });
}

/**
 * Static capability export for registries that only need the definition shape.
 * Uses the default LocalStorageAdapter rooted at `./.data/files`.
 */
export const capFileStorage: CapabilityDefinition = createCapFileStorage();
