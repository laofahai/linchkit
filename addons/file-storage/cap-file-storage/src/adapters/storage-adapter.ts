/**
 * StorageAdapter — pluggable backend contract for cap-file-storage.
 *
 * Adapters own the binary payload while the `file` entity tracks metadata.
 * A single capability instance can be configured with exactly one adapter;
 * the adapter `name` is recorded on every file record so that the right
 * backend can be chosen when reading/deleting.
 *
 * Implementations MUST:
 * - Sanitize incoming `path` values and reject absolute / parent-traversal paths.
 * - Return a stable locator from `write()` that round-trips through `read()`.
 * - Treat `read()` of a missing file as an error, not an empty payload.
 */

export interface StorageWriteInput {
  /**
   * Relative storage path the caller would like to use. Adapter MAY rewrite
   * this (for example to scope under a tenant prefix) but MUST return the
   * final locator as the `path` of `StorageWriteResult`.
   */
  path: string;
  /** Raw payload bytes */
  data: Uint8Array;
  /** MIME type hint (adapters MAY persist this as metadata) */
  mime?: string;
}

export interface StorageWriteResult {
  /** Final locator to store on the `file` record. Opaque to callers. */
  path: string;
  /** Size in bytes of what was actually written */
  size: number;
  /** Optional SHA-256 hex digest if the adapter computed one */
  checksum?: string;
}

export interface StorageAdapter {
  /** Short adapter identifier (e.g. "local", "s3") stored on each `file` record */
  readonly name: string;

  /** Write a payload and return its locator + size (+ optional checksum). */
  write(input: StorageWriteInput): Promise<StorageWriteResult>;

  /** Read the payload for a locator previously returned by `write()`. */
  read(path: string): Promise<Uint8Array>;

  /**
   * Delete the payload. MUST be idempotent — deleting a missing file
   * resolves without throwing.
   */
  delete(path: string): Promise<void>;

  /** Check existence without reading the payload. */
  exists(path: string): Promise<boolean>;
}
