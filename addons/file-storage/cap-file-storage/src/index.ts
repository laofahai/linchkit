/**
 * @linchkit/cap-file-storage — File storage capability
 *
 * Provides the `file` entity, a pluggable StorageAdapter contract, a
 * LocalStorageAdapter reference implementation, and the upload/download/delete
 * actions. A `file` field type and cloud adapters are planned follow-ups.
 */

// Actions
export { deleteFileAction } from "./actions/delete_file";
export { downloadFileAction } from "./actions/download_file";
export { uploadFileAction } from "./actions/upload_file";
// Adapters
export { LocalStorageAdapter, type LocalStorageAdapterOptions } from "./adapters/local-adapter";
export type {
  StorageAdapter,
  StorageWriteInput,
  StorageWriteResult,
} from "./adapters/storage-adapter";
// Capability
export {
  type CapFileStorageOptions,
  capFileStorage,
  createCapFileStorage,
} from "./capability";
// Entities
export { fileEntity } from "./entities/file";
// Storage registry (primarily for tests / advanced wiring)
export {
  getStorageAdapter,
  resetStorageAdapter,
  setStorageAdapter,
} from "./storage-registry";
