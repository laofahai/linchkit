/**
 * upload_file action — persist a file payload via the active StorageAdapter
 * and create a `file` entity record holding its metadata.
 *
 * Input:
 *   name        — original filename (required, non-empty)
 *   mime        — MIME type (required, non-empty)
 *   data_base64 — payload encoded as base64 (required, non-empty)
 *
 * Output: the created `file` record (with adapter-computed size + checksum).
 *
 * Storage key is ALWAYS generated server-side under the current tenant prefix.
 * Client-supplied path hints are not accepted — allowing callers to pick keys
 * enables cross-tenant blob overwrites and collision attacks.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { defineAction } from "@linchkit/core";
import { getStorageAdapter } from "../storage-registry";

function decodeBase64(input: string): Uint8Array {
  // Reject whitespace/newlines and non-base64 chars up front — native
  // `Buffer.from` is lenient and silently drops garbage, which would make
  // checksum/size numbers diverge from what the caller sent.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    throw new Error("data_base64 must be valid base64 without whitespace");
  }
  // Native base64 decode — O(n) vs. the prior `atob` + per-char loop.
  // The `new Uint8Array(buf)` wrap promotes the Node Buffer (a Uint8Array
  // subclass, but usually backed by a shared pool) to a standalone array.
  return new Uint8Array(Buffer.from(input, "base64"));
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

    // Generate a safe server-side key scoped by tenant. Not accepting caller
    // input here prevents cross-tenant overwrites and guessing attacks.
    const tenantPrefix = ctx.tenantId ? `${ctx.tenantId}/` : "";
    const relPath = `${tenantPrefix}${randomUUID()}`;

    const adapter = getStorageAdapter();
    const written = await adapter.write({ path: relPath, data, mime });

    // Compensate: if the metadata write fails (transaction rollback, validation,
    // uniqueness, etc.), we must remove the blob we just persisted — otherwise
    // the backend accumulates orphaned payloads with no entity row pointing to
    // them.
    let record: Record<string, unknown>;
    try {
      record = await ctx.create("file", {
        name,
        size: written.size,
        mime,
        path: written.path,
        adapter: adapter.name,
        checksum: written.checksum ?? "",
        uploaded_by: ctx.actor.id,
      });
    } catch (err) {
      try {
        await adapter.delete(written.path);
      } catch {
        // Best-effort compensation; surface the original error either way.
      }
      throw err;
    }

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
