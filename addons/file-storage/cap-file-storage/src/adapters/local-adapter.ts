/**
 * LocalStorageAdapter — stores files on the local filesystem.
 *
 * Intended for development and single-node deployments. Production multi-node
 * setups should use a cloud adapter (S3, GCS, etc.) which will be delivered
 * in a follow-up PR — see TODO at bottom.
 *
 * All paths are resolved relative to `rootDir` and validated to reject
 * path-traversal attempts (`..`, absolute paths, null bytes).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { StorageAdapter, StorageWriteInput, StorageWriteResult } from "./storage-adapter";

export interface LocalStorageAdapterOptions {
  /** Root directory on disk under which all files are stored */
  rootDir: string;
  /** Adapter identifier (defaults to "local") */
  name?: string;
}

/**
 * Normalize and guard a caller-supplied relative path. Throws on:
 * - absolute paths
 * - null bytes
 * - `..` segments that would escape `rootDir`
 * Returns an absolute resolved path safe to pass to fs APIs.
 */
function resolveSafe(rootDir: string, path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Storage path must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new Error("Storage path must not contain null bytes");
  }
  if (isAbsolute(path)) {
    throw new Error("Storage path must be relative");
  }
  const absRoot = resolve(rootDir);
  const absPath = resolve(absRoot, path);
  const withSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  if (absPath !== absRoot && !absPath.startsWith(withSep)) {
    throw new Error("Storage path escapes root directory");
  }
  return absPath;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly name: string;
  readonly #rootDir: string;

  constructor(options: LocalStorageAdapterOptions) {
    if (!options?.rootDir) {
      throw new Error("LocalStorageAdapter requires rootDir");
    }
    this.name = options.name ?? "local";
    this.#rootDir = resolve(options.rootDir);
  }

  async write(input: StorageWriteInput): Promise<StorageWriteResult> {
    if (!(input?.data instanceof Uint8Array)) {
      throw new Error("write() requires Uint8Array data");
    }
    const abs = resolveSafe(this.#rootDir, input.path);
    const dir = abs.slice(0, abs.lastIndexOf(sep));
    await mkdir(dir, { recursive: true });
    await writeFile(abs, input.data);

    const hash = createHash("sha256").update(input.data).digest("hex");

    return {
      path: input.path,
      size: input.data.byteLength,
      checksum: hash,
    };
  }

  async read(path: string): Promise<Uint8Array> {
    const abs = resolveSafe(this.#rootDir, path);
    const buf = await readFile(abs);
    // `readFile` returns a Buffer backed by Node's shared allocation pool
    // (`buf.buffer` can be larger than this file). Construct a fresh
    // Uint8Array from the Buffer directly — this copies the bytes and
    // detaches the result from the pool, preventing callers from reading
    // neighbor data or having their view invalidated later.
    return new Uint8Array(buf);
  }

  async delete(path: string): Promise<void> {
    const abs = resolveSafe(this.#rootDir, path);
    await rm(abs, { force: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      const abs = resolveSafe(this.#rootDir, path);
      const st = await stat(abs);
      return st.isFile();
    } catch {
      return false;
    }
  }
}

// TODO(#139 follow-up): S3StorageAdapter — AWS SDK v3 client, bucket + prefix options.
// TODO(#139 follow-up): GCSStorageAdapter, AzureBlobStorageAdapter.
// TODO(#139 follow-up): Signed URL support on StorageAdapter for direct browser upload/download.
