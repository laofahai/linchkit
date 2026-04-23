/**
 * File entity definition
 *
 * Represents a stored file's metadata. The binary payload is managed by
 * a StorageAdapter (local disk, S3, etc.); this entity only tracks the
 * metadata needed to locate and describe the file.
 *
 * System-managed fields (id, tenant_id, created_at, updated_at, created_by,
 * updated_by, _version) are injected by the core runtime and must not be
 * set by clients.
 */

import { defineEntity } from "@linchkit/core";

export const fileEntity = defineEntity({
  name: "file",
  label: "File",
  description: "Stored file metadata (binary payload is held by a StorageAdapter)",
  fields: {
    name: {
      type: "string",
      label: "File Name",
      required: true,
      description: "Original file name supplied at upload time",
    },
    size: {
      type: "number",
      label: "Size (bytes)",
      required: true,
      min: 0,
      description: "File size in bytes",
    },
    mime: {
      type: "string",
      label: "MIME Type",
      required: true,
      description: "MIME type (e.g. 'image/png', 'application/pdf')",
    },
    path: {
      type: "string",
      label: "Storage Path",
      required: true,
      description:
        "Adapter-specific storage locator (relative path, object key, URL, etc.). Opaque to consumers.",
    },
    adapter: {
      type: "string",
      label: "Storage Adapter",
      required: true,
      description: "Name of the StorageAdapter that owns this file (e.g. 'local', 's3')",
    },
    checksum: {
      type: "string",
      label: "Checksum",
      description: "SHA-256 hex digest of the stored payload (empty if not computed)",
    },
    uploaded_by: {
      type: "string",
      label: "Uploaded By",
      required: true,
      description: "Actor id that uploaded the file (mirrors created_by for convenience)",
    },
  },
  presentation: {
    titleField: "name",
    subtitleField: "mime",
    summaryFields: ["name", "size", "mime"],
    icon: "file",
  },
});
