/**
 * upload_file action — persist a file payload via the active StorageAdapter
 * and create a `file` entity record holding its metadata.
 *
 * Input:
 *   name        — original filename (required, non-empty)
 *   mime        — MIME type (required, non-empty)
 *   data_base64 — payload encoded as base64 (required, non-empty)
 *   path        — optional relative path hint; when omitted, a random key
 *                 under the current tenant prefix is generated
 *
 * Output: the created `file` record (with adapter-computed size + checksum).
 */

import { randomUUID } from "node:crypto";
import { defineAction } from "@linchkit/core";
import { getStorageAdapter } from "../storage-registry";

function decodeBase64(input: string): Uint8Array {
  // Reject whitespace/newlines and non-base64 chars explicitly — atob is lenient.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    throw new Error("data_base64 must be valid base64 without whitespace");
  }
  // Bun/Node both ship globalThis.atob.
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export const uploadFileAction = defineAction({
  name: "upload_file",
  entity: "file",
  label: "Upload File",
  description: "Store a file payload and create its metadata record",
  input: {
    name: {
      type: "string",
      label: "File Name",
      required: true,
    },
    mime: {
      type: "string",
      label: "MIME Type",
      required: true,
    },
    data_base64: {
      type: "text",
      label: "Payload (base64)",
      required: true,
      description: "File bytes encoded as base64 (no whitespace)",
    },
    path: {
      type: "string",
      label: "Storage Path Hint",
      description: "Optional relative path for the adapter. A safe key is generated when omitted.",
    },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: false,
  },
  exposure: { http: true, ui: true, cli: true, mcp: false },
  async handler(ctx) {
    const name = String(ctx.input.name ?? "").trim();
    const mime = String(ctx.input.mime ?? "").trim();
    const dataBase64 = String(ctx.input.data_base64 ?? "");
    const pathHint =
      typeof ctx.input.path === "string" && ctx.input.path.length > 0 ? ctx.input.path : undefined;

    if (!name) {
      throw new Error("File name is required");
    }
    if (!mime) {
      throw new Error("MIME type is required");
    }
    if (!dataBase64) {
      throw new Error("File payload (data_base64) is required");
    }

    const data = decodeBase64(dataBase64);

    // Build a safe default relative path. The adapter re-validates it.
    const tenantPrefix = ctx.tenantId ? `${ctx.tenantId}/` : "";
    const relPath = pathHint ?? `${tenantPrefix}${randomUUID()}`;

    const adapter = getStorageAdapter();
    const written = await adapter.write({ path: relPath, data, mime });

    const record = await ctx.create("file", {
      name,
      size: written.size,
      mime,
      path: written.path,
      adapter: adapter.name,
      checksum: written.checksum ?? "",
      uploaded_by: ctx.actor.id,
    });

    ctx.emit("file.uploaded", {
      file_id: record.id,
      name,
      size: written.size,
      mime,
      uploaded_by: ctx.actor.id,
    });

    return record;
  },
});
